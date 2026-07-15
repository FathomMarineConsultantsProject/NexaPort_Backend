import { pool } from "../config/db.js";
import { writeAdminAudit } from "../services/adminAuditService.js";
import { enqueueS3Cleanup } from "../services/s3CleanupService.js";

const positiveId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};
const textOrNull = (value) => String(value ?? "").trim() || null;
const normalizedEmail = (value) => String(value ?? "").trim().toLowerCase();
const validEmail = (value) => /^\S+@\S+\.\S+$/.test(value);

const consultantImpact = async (queryable, expertId) => {
  const target = await queryable.query(
    `SELECT e.id, e.user_id, e.full_name, u.email, erd.photo_s3_key, erd.cv_s3_key
     FROM experts e JOIN users u ON u.id=e.user_id
     LEFT JOIN expert_registration_details erd ON erd.expert_id=e.id
     WHERE e.id=$1`,
    [expertId]
  );
  if (!target.rows.length) return null;
  const userId = target.rows[0].user_id;
  const result = await queryable.query(
    `SELECT
      (SELECT COUNT(*)::int FROM quotations WHERE expert_id=$1 OR expert_user_id=$2) AS quotations,
      (SELECT COUNT(*)::int FROM quotations WHERE (expert_id=$1 OR expert_user_id=$2) AND status='accepted') AS accepted_quotations,
      (SELECT COUNT(*)::int FROM request_expert_assignments rea JOIN service_requests sr ON sr.id=rea.service_request_id WHERE rea.expert_id=$1 AND LOWER(sr.status) NOT IN ('completed','cancelled')) AS active_assignments,
      (SELECT COUNT(*)::int FROM request_expert_assignments rea JOIN service_requests sr ON sr.id=rea.service_request_id WHERE rea.expert_id=$1 AND LOWER(sr.status) IN ('completed','cancelled')) AS history_assignments,
      (SELECT COUNT(*)::int FROM expert_reviews WHERE expert_id=$1) AS reviews,
      (SELECT COUNT(*)::int FROM service_requests WHERE accepted_expert_id=$1) AS request_references,
      (SELECT COUNT(*)::int FROM admin_notifications WHERE recipient_user_id=$2) AS notifications,
      (SELECT COUNT(*)::int FROM expert_registration_details WHERE expert_id=$1 AND (photo_s3_key IS NOT NULL OR cv_s3_key IS NOT NULL)) AS profile_documents`,
    [expertId, userId]
  );
  const counts = result.rows[0];
  return {
    target: target.rows[0],
    counts,
    hasImmutableHistory: ["quotations", "accepted_quotations", "active_assignments", "history_assignments", "reviews", "request_references"]
      .some((key) => Number(counts[key]) > 0),
  };
};

export const getConsultantDeletionImpact = async (req, res) => {
  try {
    const id = positiveId(req.params.expertId);
    if (!id) return res.status(400).json({ success: false, message: "Invalid Consultant ID" });
    const impact = await consultantImpact(pool, id);
    if (!impact) return res.status(404).json({ success: false, message: "Consultant not found" });
    return res.json({ success: true, data: { ...impact.counts, has_immutable_history: impact.hasImmutableHistory } });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to inspect Consultant dependencies", error: error.message });
  }
};

export const updateConsultantAsAdmin = async (req, res) => {
  const client = await pool.connect();
  try {
    const id = positiveId(req.params.expertId);
    await client.query("BEGIN");
    const target = await client.query(`SELECT e.id, e.user_id FROM experts e JOIN users u ON u.id=e.user_id WHERE e.id=$1 FOR UPDATE OF e, u`, [id]);
    if (!target.rows.length) throw Object.assign(new Error("Consultant not found"), { status: 404 });
    const { user = {}, expert = {}, flag_services: flagServices } = req.body || {};
    if (user.full_name !== undefined && expert.full_name === undefined) expert.full_name = user.full_name;
    if (user.email !== undefined) {
      const email = normalizedEmail(user.email);
      if (!validEmail(email)) throw Object.assign(new Error("A valid email is required"), { status: 400 });
      const duplicate = await client.query(`SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND id<>$2`, [email, target.rows[0].user_id]);
      if (duplicate.rows.length) throw Object.assign(new Error("Email is already in use"), { status: 409 });
      user.email = email;
    }
    const userMap = { full_name: "full_name", email: "email", phone: "phone", is_active: "is_active" };
    const expertMap = { full_name: "full_name", biography: "biography", base_location: "base_location", country: "country", day_rate_usd: "day_rate_usd", years_experience: "years_experience", availability: "availability", is_premium: "is_premium" };
    const runUpdate = async (table, map, valuesObject, keyColumn, keyValue) => {
      const sets = []; const values = [];
      for (const [key, column] of Object.entries(map)) if (key in valuesObject) { values.push(valuesObject[key]); sets.push(`${column}=$${values.length}`); }
      if (!sets.length) return;
      values.push(keyValue);
      await client.query(`UPDATE ${table} SET ${sets.join(", ")}, updated_at=CURRENT_TIMESTAMP WHERE ${keyColumn}=$${values.length}`, values);
    };
    await runUpdate("users", userMap, user, "id", target.rows[0].user_id);
    await runUpdate("experts", expertMap, expert, "id", id);
    if (Array.isArray(flagServices)) {
      const ids = flagServices.map((item) => Number(item.flag_id));
      if (ids.some((flagId) => !Number.isInteger(flagId) || flagId <= 0)) {
        throw Object.assign(new Error("Invalid flag service selection"), { status: 400 });
      }
      if (ids.length) {
        const valid = await client.query(`SELECT id FROM master_flag_states WHERE id = ANY($1::int[])`, [ids]);
        if (valid.rows.length !== new Set(ids).size) throw Object.assign(new Error("One or more flag services are invalid"), { status: 400 });
      }
      await client.query(`DELETE FROM expert_flag_coverage WHERE expert_flag_id IN (SELECT id FROM expert_flags WHERE expert_id=$1)`, [id]);
      await client.query(`DELETE FROM expert_flags WHERE expert_id=$1`, [id]);
      for (const service of flagServices) {
        const inserted = await client.query(`INSERT INTO expert_flags (expert_id,flag_id,is_active) VALUES ($1,$2,TRUE) RETURNING id`, [id, Number(service.flag_id)]);
        for (const coverage of Array.isArray(service.coverage) ? service.coverage : []) {
          await client.query(`INSERT INTO expert_flag_coverage (expert_flag_id,country,region,location,coverage_note,is_active) VALUES ($1,$2,$3,$4,$5,TRUE)`, [inserted.rows[0].id, textOrNull(coverage.country), textOrNull(coverage.region), textOrNull(coverage.location), textOrNull(coverage.coverage_note)]);
        }
      }
    }
    await writeAdminAudit(client, { actorUserId: req.user.id, action: "consultant.edited", targetType: "consultant", targetId: id, summary: "Updated permitted Consultant account/profile fields" });
    await client.query("COMMIT");
    return res.json({ success: true, message: "Consultant updated" });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Failed to update Consultant" });
  } finally { client.release(); }
};

const queueConsultantMedia = async (client, target) => {
  if (target.photo_s3_key) await enqueueS3Cleanup(client, "consultant_photo", target.photo_s3_key);
  if (target.cv_s3_key) await enqueueS3Cleanup(client, "consultant_cv", target.cv_s3_key);
};

export const deleteConsultantAsAdmin = async (req, res) => {
  if (req.body?.confirmation !== "DELETE") return res.status(400).json({ success: false, message: "Type DELETE to confirm" });
  const client = await pool.connect();
  try {
    const id = positiveId(req.params.expertId);
    await client.query("BEGIN");
    const impact = await consultantImpact(client, id);
    if (!impact) throw Object.assign(new Error("Consultant not found"), { status: 404 });
    await client.query(`SELECT id FROM experts WHERE id=$1 FOR UPDATE`, [id]);
    await client.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [impact.target.user_id]);
    if (impact.hasImmutableHistory) throw Object.assign(new Error("Consultant has business history and must be deactivated and anonymized"), { status: 409, code: "IMMUTABLE_HISTORY" });
    await queueConsultantMedia(client, impact.target);
    await client.query(`DELETE FROM expert_flag_coverage WHERE expert_flag_id IN (SELECT id FROM expert_flags WHERE expert_id=$1)`, [id]);
    for (const table of ["expert_flags", "expert_specialties", "expert_certifications", "expert_vessel_types", "expert_ports", "expert_languages", "expert_registration_details"]) {
      await client.query(`DELETE FROM ${table} WHERE expert_id=$1`, [id]);
    }
    await client.query(`DELETE FROM admin_notifications WHERE recipient_user_id=$1 OR (entity_type='consultant' AND entity_id=$2)`, [impact.target.user_id, String(id)]);
    await client.query(`DELETE FROM experts WHERE id=$1`, [id]);
    await client.query(`DELETE FROM users WHERE id=$1 AND role_id=2`, [impact.target.user_id]);
    await writeAdminAudit(client, { actorUserId: req.user.id, action: "consultant.deleted", targetType: "consultant", targetId: id, summary: `Permanently deleted dependency-free Consultant ${impact.target.full_name}` });
    await client.query("COMMIT");
    return res.json({ success: true, message: "Consultant permanently deleted; private media cleanup queued" });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(error.status || 500).json({ success: false, code: error.code, message: error.status ? error.message : "Failed to delete Consultant" });
  } finally { client.release(); }
};

export const deactivateConsultantAsAdmin = async (req, res) => {
  const reason = textOrNull(req.body?.reason);
  if (req.body?.confirmation !== "DEACTIVATE" || !reason) return res.status(400).json({ success: false, message: "Type DEACTIVATE and provide a reason" });
  const client = await pool.connect();
  try {
    const id = positiveId(req.params.expertId);
    await client.query("BEGIN");
    const impact = await consultantImpact(client, id);
    if (!impact) throw Object.assign(new Error("Consultant not found"), { status: 404 });
    const uid = impact.target.user_id;
    await queueConsultantMedia(client, impact.target);
    await client.query(`UPDATE users SET full_name=$1,email=$2,phone=NULL,is_active=FALSE,updated_at=CURRENT_TIMESTAMP WHERE id=$3 AND role_id=2`, [`Deleted Consultant ${uid}`, `deleted-consultant-${uid}@invalid.nexaport.local`, uid]);
    await client.query(`UPDATE experts SET full_name=$1,biography=NULL,base_location=NULL,country=NULL,availability='unavailable',updated_at=CURRENT_TIMESTAMP WHERE id=$2`, [`Deleted Consultant ${id}`, id]);
    await client.query(`UPDATE expert_registration_details SET first_name='Deleted',last_name=$1,phone_number='REDACTED',mobile_number=NULL,email=$2,company_name=NULL,street1='REDACTED',street2=NULL,city='REDACTED',postal_code='REDACTED',photo_s3_key=NULL,cv_s3_key=NULL,refs='[]'::jsonb,updated_at=CURRENT_TIMESTAMP WHERE expert_id=$3`, [String(id), `deleted-consultant-${uid}@invalid.nexaport.local`, id]);
    await writeAdminAudit(client, { actorUserId: req.user.id, action: "consultant.deactivated_anonymized", targetType: "consultant", targetId: id, summary: "Deactivated and anonymized Consultant while retaining business history", reason });
    await client.query("COMMIT");
    return res.json({ success: true, message: "Consultant deactivated and anonymized; private media cleanup queued" });
  } catch (error) { await client.query("ROLLBACK"); return res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Failed to deactivate Consultant" }); }
  finally { client.release(); }
};

const clientImpact = async (queryable, userId) => {
  const target = await queryable.query(`SELECT u.id,u.full_name,u.email,cp.id AS client_profile_id FROM users u LEFT JOIN client_profiles cp ON cp.user_id=u.id WHERE u.id=$1 AND u.role_id=3`, [userId]);
  if (!target.rows.length) return null;
  const profileId = target.rows[0].client_profile_id;
  const result = await queryable.query(
    `SELECT
      (SELECT COUNT(*)::int FROM service_requests WHERE requester_user_id=$1) AS service_requests,
      (SELECT COUNT(*)::int FROM quotations q JOIN service_requests sr ON sr.id=q.service_request_id WHERE sr.requester_user_id=$1) AS quotations,
      (SELECT COUNT(*)::int FROM quotations q JOIN service_requests sr ON sr.id=q.service_request_id WHERE sr.requester_user_id=$1 AND q.status='accepted') AS accepted_quotations,
      (SELECT COUNT(*)::int FROM service_requests WHERE requester_user_id=$1 AND LOWER(status) NOT IN ('completed','cancelled')) AS active_assignments,
      (SELECT COUNT(*)::int FROM vessels WHERE created_by_user_id=$1) AS vessels,
      (SELECT COUNT(*)::int FROM expert_reviews WHERE reviewer_user_id=$1) AS reviews,
      (SELECT COUNT(*)::int FROM client_onboarding_vessels WHERE client_profile_id=$2) AS onboarding_vessels,
      (SELECT COUNT(*)::int FROM client_verification_documents WHERE client_profile_id=$2) AS verification_documents,
      (SELECT COUNT(*)::int FROM client_verification_events WHERE client_profile_id=$2) AS verification_events,
      (SELECT COUNT(*)::int FROM admin_notifications WHERE recipient_user_id=$1) AS notifications`,
    [userId, profileId]
  );
  const counts = result.rows[0];
  return { target: target.rows[0], counts, hasImmutableHistory: ["service_requests", "quotations", "accepted_quotations", "active_assignments", "vessels", "reviews"].some((key) => Number(counts[key]) > 0) };
};

export const listClientsAsAdmin = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const verification = String(req.query.verification_status || "").trim();
    const active = String(req.query.active_status || "").trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const conditions = ["u.role_id=3"]; const values = [];
    if (search) { values.push(`%${search}%`); conditions.push(`(u.full_name ILIKE $${values.length} OR u.email ILIKE $${values.length} OR u.phone ILIKE $${values.length} OR cc.legal_name ILIKE $${values.length} OR cc.registration_number ILIKE $${values.length})`); }
    if (verification === "legacy") conditions.push("cp.id IS NULL");
    else if (verification) { values.push(verification); conditions.push(`cp.verification_status=$${values.length}`); }
    if (["true", "false"].includes(active)) { values.push(active === "true"); conditions.push(`u.is_active=$${values.length}`); }
    const where = conditions.join(" AND ");
    const countValues = [...values]; values.push(limit, (page - 1) * limit);
    const [rows, count] = await Promise.all([
      pool.query(`SELECT u.id AS user_id,cp.id AS client_profile_id,u.full_name,u.email,u.phone,cc.legal_name AS company_legal_name,cc.country,COALESCE(cp.verification_status,'legacy') AS verification_status,u.is_active,u.created_at,(cp.id IS NULL) AS is_legacy FROM users u LEFT JOIN client_profiles cp ON cp.user_id=u.id LEFT JOIN client_companies cc ON cc.client_profile_id=cp.id WHERE ${where} ORDER BY u.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values),
      pool.query(`SELECT COUNT(*)::int AS total FROM users u LEFT JOIN client_profiles cp ON cp.user_id=u.id LEFT JOIN client_companies cc ON cc.client_profile_id=cp.id WHERE ${where}`, countValues),
    ]);
    return res.json({ success: true, data: rows.rows, pagination: { page, limit, total: count.rows[0].total, pages: Math.max(1, Math.ceil(count.rows[0].total / limit)) } });
  } catch (error) { return res.status(500).json({ success: false, message: "Failed to list Clients", error: error.message }); }
};

export const getClientAsAdmin = async (req, res) => {
  try {
    const uid = positiveId(req.params.userId); const impact = await clientImpact(pool, uid);
    if (!impact) return res.status(404).json({ success: false, message: "Client not found" });
    const detail = await pool.query(`SELECT u.id AS user_id,u.full_name,u.email,u.phone,u.is_active,u.created_at,cp.id AS client_profile_id,cp.designation,cp.declared_vessel_count,cp.verification_status,cc.* FROM users u LEFT JOIN client_profiles cp ON cp.user_id=u.id LEFT JOIN client_companies cc ON cc.client_profile_id=cp.id WHERE u.id=$1 AND u.role_id=3`, [uid]);
    return res.json({ success: true, data: { client: detail.rows[0], dependencies: impact.counts, has_immutable_history: impact.hasImmutableHistory } });
  } catch (error) { return res.status(500).json({ success: false, message: "Failed to load Client", error: error.message }); }
};

export const getClientDeletionImpact = async (req, res) => {
  try { const impact = await clientImpact(pool, positiveId(req.params.userId)); if (!impact) return res.status(404).json({ success: false, message: "Client not found" }); return res.json({ success: true, data: { ...impact.counts, has_immutable_history: impact.hasImmutableHistory } }); }
  catch (error) { return res.status(500).json({ success: false, message: "Failed to inspect Client dependencies", error: error.message }); }
};

export const updateClientAsAdmin = async (req, res) => {
  const client = await pool.connect();
  try {
    const uid = positiveId(req.params.userId); await client.query("BEGIN");
    const target = await client.query(`SELECT u.id,cp.id AS profile_id FROM users u LEFT JOIN client_profiles cp ON cp.user_id=u.id WHERE u.id=$1 AND u.role_id=3 FOR UPDATE OF u`, [uid]);
    if (!target.rows.length) throw Object.assign(new Error("Client not found"), { status: 404 });
    const { user = {}, profile = {}, company = {} } = req.body || {};
    if (user.email !== undefined) { const email=normalizedEmail(user.email); if (!validEmail(email)) throw Object.assign(new Error("A valid email is required"),{status:400}); const duplicate=await client.query(`SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND id<>$2`,[email,uid]); if(duplicate.rows.length) throw Object.assign(new Error("Email is already in use"),{status:409}); user.email=email; }
    const updateAllowed = async (table, map, obj, key, value) => { const sets=[]; const values=[]; for(const [field,column] of Object.entries(map)) if(field in obj){values.push(obj[field]);sets.push(`${column}=$${values.length}`);} if(!sets.length)return; values.push(value); await client.query(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${key}=$${values.length}`,values); };
    await updateAllowed("users",{full_name:"full_name",email:"email",phone:"phone",is_active:"is_active"},user,"id",uid);
    const pid=target.rows[0].profile_id;
    if (pid) {
      await updateAllowed("client_profiles",{designation:"designation",declared_vessel_count:"declared_vessel_count"},profile,"id",pid);
      const companyMap={legal_name:"legal_name",company_type:"company_type",registered_address:"registered_address",country:"country",registration_number:"registration_number",website:"website",imo_company_number:"imo_company_number",tax_number:"tax_number",authorized_representative_name:"authorized_representative_name",authorized_representative_designation:"authorized_representative_designation",authorized_representative_email:"authorized_representative_email",authorized_representative_phone:"authorized_representative_phone"};
      if (Object.keys(company).length) { const existing=await client.query(`SELECT id FROM client_companies WHERE client_profile_id=$1`,[pid]); if(!existing.rows.length) throw Object.assign(new Error("Client company record is missing"),{status:409}); for(const field of ["registration_number","imo_company_number"]){if(company[field]){const duplicate=await client.query(`SELECT id FROM client_companies WHERE LOWER(TRIM(${field}))=LOWER(TRIM($1)) AND client_profile_id<>$2 LIMIT 1`,[company[field],pid]);if(duplicate.rows.length)throw Object.assign(new Error(`${field.replaceAll("_"," ")} is already in use`),{status:409});}} await updateAllowed("client_companies",companyMap,company,"client_profile_id",pid); }
    } else if (Object.keys(profile).length || Object.keys(company).length) throw Object.assign(new Error("Legacy Client has no editable profile/company record"),{status:409});
    await writeAdminAudit(client,{actorUserId:req.user.id,action:"client.edited",targetType:"client",targetId:uid,summary:"Updated permitted Client account/profile/company fields"}); await client.query("COMMIT"); return res.json({success:true,message:"Client updated"});
  } catch(error){await client.query("ROLLBACK");return res.status(error.status||500).json({success:false,message:error.status?error.message:"Failed to update Client"});} finally{client.release();}
};

const queueClientDocuments = async (client, profileId) => {
  if (!profileId) return;
  const docs=await client.query(`SELECT s3_key FROM client_verification_documents WHERE client_profile_id=$1`,[profileId]);
  for(const doc of docs.rows) await enqueueS3Cleanup(client,"client_verification_document",doc.s3_key);
};

export const deleteClientAsAdmin = async (req,res)=>{
  if(req.body?.confirmation!=="DELETE")return res.status(400).json({success:false,message:"Type DELETE to confirm"}); const client=await pool.connect();
  try{const uid=positiveId(req.params.userId);await client.query("BEGIN");const impact=await clientImpact(client,uid);if(!impact)throw Object.assign(new Error("Client not found"),{status:404});await client.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`,[uid]);if(impact.hasImmutableHistory)throw Object.assign(new Error("Client has business history and must be deactivated and anonymized"),{status:409,code:"IMMUTABLE_HISTORY"});const pid=impact.target.client_profile_id;await queueClientDocuments(client,pid);if(pid){await client.query(`DELETE FROM admin_notifications WHERE entity_type='client_registration' AND entity_id=$1`,[String(pid)]);await client.query(`DELETE FROM client_verification_documents WHERE client_profile_id=$1`,[pid]);await client.query(`DELETE FROM client_verification_events WHERE client_profile_id=$1`,[pid]);await client.query(`DELETE FROM client_required_services WHERE client_profile_id=$1`,[pid]);await client.query(`DELETE FROM client_onboarding_vessels WHERE client_profile_id=$1`,[pid]);await client.query(`DELETE FROM client_companies WHERE client_profile_id=$1`,[pid]);await client.query(`DELETE FROM client_profiles WHERE id=$1`,[pid]);}await client.query(`DELETE FROM admin_notifications WHERE recipient_user_id=$1`,[uid]);await client.query(`DELETE FROM users WHERE id=$1 AND role_id=3`,[uid]);await writeAdminAudit(client,{actorUserId:req.user.id,action:"client.deleted",targetType:"client",targetId:uid,summary:`Permanently deleted dependency-free Client ${impact.target.full_name}`});await client.query("COMMIT");return res.json({success:true,message:"Client permanently deleted; private document cleanup queued"});}catch(error){await client.query("ROLLBACK");return res.status(error.status||500).json({success:false,code:error.code,message:error.status?error.message:"Failed to delete Client"});}finally{client.release();}
};

export const deactivateClientAsAdmin=async(req,res)=>{
  const reason=textOrNull(req.body?.reason);if(req.body?.confirmation!=="DEACTIVATE"||!reason)return res.status(400).json({success:false,message:"Type DEACTIVATE and provide a reason"});const client=await pool.connect();
  try{const uid=positiveId(req.params.userId);await client.query("BEGIN");const impact=await clientImpact(client,uid);if(!impact)throw Object.assign(new Error("Client not found"),{status:404});await client.query(`UPDATE users SET full_name=$1,email=$2,phone=NULL,is_active=FALSE,updated_at=CURRENT_TIMESTAMP WHERE id=$3 AND role_id=3`,[`Deleted Client ${uid}`,`deleted-client-${uid}@invalid.nexaport.local`,uid]);const pid=impact.target.client_profile_id;if(pid){await client.query(`UPDATE client_companies SET legal_name=$1,registered_address='REDACTED',website=NULL,tax_number=NULL,authorized_representative_name='REDACTED',authorized_representative_designation=NULL,authorized_representative_email=$2,authorized_representative_phone='REDACTED' WHERE client_profile_id=$3`,[`Deleted Client Company ${uid}`,`deleted-client-${uid}@invalid.nexaport.local`,pid]);}await writeAdminAudit(client,{actorUserId:req.user.id,action:"client.deactivated_anonymized",targetType:"client",targetId:uid,summary:"Deactivated and anonymized Client while retaining business history",reason});await client.query("COMMIT");return res.json({success:true,message:"Client deactivated and anonymized"});}catch(error){await client.query("ROLLBACK");return res.status(error.status||500).json({success:false,message:error.status?error.message:"Failed to deactivate Client"});}finally{client.release();}
};
