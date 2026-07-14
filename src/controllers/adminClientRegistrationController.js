import { pool } from "../config/db.js";
import { createPresignedGetUrl } from "../utils/s3Presign.js";
import { DOCUMENT_CATEGORIES, publicDocument } from "../services/clientDocumentService.js";

const validStatus = (value) => ["pending", "approved", "rejected"].includes(value);

export const listClientRegistrations = async (req, res) => {
  try {
    const status = String(req.query.status || "pending").toLowerCase();
    const search = String(req.query.search || "").trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    if (!validStatus(status)) return res.status(400).json({ success: false, message: "Invalid verification status." });
    const pattern = `%${search}%`;
    const values = [status, pattern, limit, (page - 1) * limit];
    const filter = `cp.verification_status = $1 AND ($2 = '%%' OR u.full_name ILIKE $2 OR u.email ILIKE $2 OR cc.legal_name ILIKE $2 OR cc.registration_number ILIKE $2)`;
    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT cp.id, cp.verification_status, cp.verification_submitted_at, cp.resubmission_count, u.full_name, u.email, cc.legal_name AS company_legal_name, cc.country, cc.registration_number FROM client_profiles cp JOIN users u ON u.id=cp.user_id LEFT JOIN client_companies cc ON cc.client_profile_id=cp.id WHERE ${filter} ORDER BY cp.verification_submitted_at DESC NULLS LAST, cp.id DESC LIMIT $3 OFFSET $4`,
        values
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM client_profiles cp JOIN users u ON u.id=cp.user_id LEFT JOIN client_companies cc ON cc.client_profile_id=cp.id WHERE ${filter}`, values.slice(0, 2)),
    ]);
    return res.json({ success: true, data: rows.rows, pagination: { page, limit, total: count.rows[0].total, pages: Math.ceil(count.rows[0].total / limit) } });
  } catch {
    return res.status(500).json({ success: false, message: "Failed to list Client registrations." });
  }
};

const loadRegistration = async (queryable, id, lock = false) => {
  const profileResult = await queryable.query(
    `SELECT cp.*, u.full_name, u.email, u.phone, u.username, u.is_active FROM client_profiles cp JOIN users u ON u.id=cp.user_id WHERE cp.id=$1 ${lock ? "FOR UPDATE OF cp" : ""}`,
    [id]
  );
  const profile = profileResult.rows[0];
  if (!profile) return null;
  const [company, vessels, services, documents, events] = await Promise.all([
    queryable.query(`SELECT * FROM client_companies WHERE client_profile_id=$1`, [id]),
    queryable.query(`SELECT cov.*, mvt.name AS vessel_type_name FROM client_onboarding_vessels cov LEFT JOIN master_vessel_types mvt ON mvt.id=cov.vessel_type_id WHERE cov.client_profile_id=$1 ORDER BY cov.id`, [id]),
    queryable.query(`SELECT id, service_type_id, service_category_id, service_name_snapshot, other_service_text, created_at FROM client_required_services WHERE client_profile_id=$1 ORDER BY id`, [id]),
    queryable.query(`SELECT id, document_category, original_filename, mime_type, size_bytes, is_current, uploaded_at FROM client_verification_documents WHERE client_profile_id=$1 AND is_current=TRUE ORDER BY document_category`, [id]),
    queryable.query(`SELECT previous_status, new_status, actor_user_id, public_reason, internal_note, created_at FROM client_verification_events WHERE client_profile_id=$1 ORDER BY created_at DESC`, [id]),
  ]);
  return { profile, company: company.rows[0] || null, vessels: vessels.rows, services: services.rows, documents: documents.rows.map(publicDocument), history: events.rows };
};

export const getClientRegistration = async (req, res) => {
  try {
    const data = await loadRegistration(pool, Number(req.params.id));
    if (!data) return res.status(404).json({ success: false, message: "Client registration not found." });
    return res.json({ success: true, data });
  } catch {
    return res.status(500).json({ success: false, message: "Failed to load Client registration." });
  }
};

const validImo = (value) => {
  const digits = String(value || "").replace(/^IMO\s*/i, "").replace(/\s/g, "");
  if (!/^\d{7}$/.test(digits)) return false;
  const total = digits.slice(0, 6).split("").reduce((sum, digit, index) => sum + Number(digit) * (7 - index), 0);
  return total % 10 === Number(digits[6]);
};

export const approveClientRegistration = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const registration = await loadRegistration(client, Number(req.params.id), true);
    if (!registration) throw Object.assign(new Error("Client registration not found."), { status: 404 });
    if (registration.profile.verification_status !== "pending") throw Object.assign(new Error("Only pending registrations can be approved."), { status: 409 });
    if (!registration.company) throw Object.assign(new Error("Company details are required."), { status: 409 });
    if (!registration.services.length) throw Object.assign(new Error("At least one required service is required."), { status: 409 });
    const categories = new Set(registration.documents.map((document) => document.document_category));
    if (DOCUMENT_CATEGORIES.some((category) => !categories.has(category))) throw Object.assign(new Error("All required current verification documents are required."), { status: 409 });

    for (const onboarding of registration.vessels) {
      if (onboarding.converted_vessel_id || !onboarding.imo_number) continue;
      if (!validImo(onboarding.imo_number)) throw Object.assign(new Error(`Invalid IMO number for ${onboarding.vessel_name}.`), { status: 409 });
      const duplicate = await client.query(`SELECT id, created_by_user_id FROM vessels WHERE imo_number=$1 AND is_active=TRUE LIMIT 1 FOR UPDATE`, [onboarding.imo_number]);
      if (duplicate.rows.length) {
        if (Number(duplicate.rows[0].created_by_user_id) !== Number(registration.profile.user_id)) throw Object.assign(new Error(`IMO ${onboarding.imo_number} already belongs to another Client and requires resolution.`), { status: 409 });
        await client.query(`UPDATE client_onboarding_vessels SET converted_vessel_id=$1 WHERE id=$2`, [duplicate.rows[0].id, onboarding.id]);
        continue;
      }
      const vesselType = onboarding.vessel_type_name || onboarding.vessel_type_text;
      if (!vesselType) continue;
      const created = await client.query(
        `INSERT INTO vessels (vessel_name, imo_number, vessel_type, flag_state, trading_area, owner_manager, created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [onboarding.vessel_name, onboarding.imo_number, vesselType, "Not provided during onboarding", onboarding.operating_regions, onboarding.ownership_relationship, registration.profile.user_id]
      );
      await client.query(`UPDATE client_onboarding_vessels SET converted_vessel_id=$1 WHERE id=$2`, [created.rows[0].id, onboarding.id]);
    }

    await client.query(
      `UPDATE client_profiles SET verification_status='approved', verified_at=CURRENT_TIMESTAMP, verified_by_user_id=$1, rejection_reason=NULL, verification_notes=COALESCE($2, verification_notes) WHERE id=$3`,
      [req.user.id, String(req.body?.internal_note || "").trim() || null, registration.profile.id]
    );
    await client.query(
      `INSERT INTO client_verification_events (client_profile_id, previous_status, new_status, actor_user_id, internal_note) VALUES ($1,'pending','approved',$2,$3)`,
      [registration.profile.id, req.user.id, String(req.body?.internal_note || "").trim() || null]
    );
    await client.query("COMMIT");
    return res.json({ success: true, message: "Client registration approved.", verification_status: "approved" });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return res.status(409).json({ success: false, message: "An onboarding vessel IMO conflicts with an existing vessel." });
    return res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Client registration approval failed." });
  } finally {
    client.release();
  }
};

export const rejectClientRegistration = async (req, res) => {
  const rejectionReason = String(req.body?.rejection_reason || "").trim();
  const internalNote = String(req.body?.internal_note || "").trim() || null;
  if (!rejectionReason || rejectionReason.length > 1000) return res.status(400).json({ success: false, message: "A rejection reason of 1 to 1000 characters is required." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const registration = await loadRegistration(client, Number(req.params.id), true);
    if (!registration) throw Object.assign(new Error("Client registration not found."), { status: 404 });
    if (registration.profile.verification_status !== "pending") throw Object.assign(new Error("Only pending registrations can be rejected."), { status: 409 });
    await client.query(`UPDATE client_profiles SET verification_status='rejected', rejection_reason=$1, verification_notes=COALESCE($2, verification_notes), verified_at=NULL, verified_by_user_id=NULL WHERE id=$3`, [rejectionReason, internalNote, registration.profile.id]);
    await client.query(`INSERT INTO client_verification_events (client_profile_id, previous_status, new_status, actor_user_id, public_reason, internal_note) VALUES ($1,'pending','rejected',$2,$3,$4)`, [registration.profile.id, req.user.id, rejectionReason, internalNote]);
    await client.query("COMMIT");
    return res.json({ success: true, message: "Client registration rejected.", verification_status: "rejected" });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Client registration rejection failed." });
  } finally {
    client.release();
  }
};

export const getClientDocumentDownloadUrl = async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, s3_key FROM client_verification_documents WHERE id=$1 AND client_profile_id=$2 AND is_current=TRUE`, [Number(req.params.documentId), Number(req.params.clientProfileId)]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: "Verification document not found." });
    const signed = createPresignedGetUrl({ key: result.rows[0].s3_key, expiresInSeconds: 600 });
    return res.json({ success: true, url: signed.url, expiresAt: signed.expiresAt });
  } catch {
    return res.status(500).json({ success: false, message: "Failed to create private document URL." });
  }
};
