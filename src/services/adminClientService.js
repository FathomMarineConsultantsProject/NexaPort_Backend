import { pool } from "../config/db.js";
import { writeAdminAudit } from "./adminAuditService.js";

const COMPANY_TYPES = new Set(["Ship Owner", "Ship Manager", "Charterer", "Broker", "Bank", "Insurer", "Other"]);
const ACTIVE_REQUEST_STATUSES = ["completed", "cancelled"];
const USER_FIELDS = ["full_name", "email", "phone"];
const PROFILE_FIELDS = ["designation", "declared_vessel_count"];
const COMPANY_FIELDS = [
  "legal_name", "company_type", "registered_address", "country", "registration_number",
  "website", "imo_company_number", "tax_number", "authorized_representative_name",
  "authorized_representative_designation", "authorized_representative_email",
  "authorized_representative_phone",
];

const clean = (value) => String(value ?? "").trim();
const nullable = (value) => clean(value) || null;
const normalized = (value) => clean(value).toLowerCase();
const validEmail = (value) => /^\S+@\S+\.\S+$/.test(value);
const validPhone = (value) => !value || /^[+()0-9 .-]{5,30}$/.test(value);
const ownFields = (source, fields) => Object.fromEntries(fields.filter((field) => Object.hasOwn(source || {}, field)).map((field) => [field, source[field]]));

const validationError = (fieldErrors) => Object.assign(new Error("Please correct the highlighted fields."), {
  status: 400,
  code: "CLIENT_VALIDATION_FAILED",
  fieldErrors,
});

const assertLengths = (values, limits, errors, prefix) => {
  for (const [field, max] of Object.entries(limits)) {
    if (Object.hasOwn(values, field) && clean(values[field]).length > max) errors[`${prefix}.${field}`] = `Must be ${max} characters or fewer.`;
  }
};

const validatePatch = ({ user, profile, company }, { creatingCompany = false } = {}) => {
  const errors = {};
  if (Object.hasOwn(user, "full_name") && !clean(user.full_name)) errors["user.full_name"] = "Full name is required.";
  if (Object.hasOwn(user, "email")) {
    const email = normalized(user.email);
    if (!validEmail(email)) errors["user.email"] = "Enter a valid email address.";
  }
  if (Object.hasOwn(user, "phone") && !validPhone(clean(user.phone))) errors["user.phone"] = "Enter a valid phone number.";
  assertLengths(user, { full_name: 160, email: 254, phone: 30 }, errors, "user");

  if (Object.hasOwn(profile, "designation") && clean(profile.designation).length > 160) errors["profile.designation"] = "Must be 160 characters or fewer.";
  if (Object.hasOwn(profile, "declared_vessel_count")) {
    const count = Number(profile.declared_vessel_count);
    if (!Number.isInteger(count) || count < 0) errors["profile.declared_vessel_count"] = "Enter a whole number of zero or more.";
  }

  const requiredCompany = ["legal_name", "company_type", "registered_address", "country", "registration_number", "authorized_representative_name", "authorized_representative_email", "authorized_representative_phone"];
  if (creatingCompany) for (const field of requiredCompany) if (!clean(company[field])) errors[`company.${field}`] = "This field is required.";
  if (Object.hasOwn(company, "company_type") && clean(company.company_type) && !COMPANY_TYPES.has(clean(company.company_type))) errors["company.company_type"] = "Select a valid company type.";
  if (Object.hasOwn(company, "authorized_representative_email") && clean(company.authorized_representative_email) && !validEmail(normalized(company.authorized_representative_email))) errors["company.authorized_representative_email"] = "Enter a valid email address.";
  if (Object.hasOwn(company, "authorized_representative_phone") && !validPhone(clean(company.authorized_representative_phone))) errors["company.authorized_representative_phone"] = "Enter a valid phone number.";
  if (Object.hasOwn(company, "website") && clean(company.website)) {
    try { const url = new URL(clean(company.website)); if (!["http:", "https:"].includes(url.protocol)) throw new Error(); }
    catch { errors["company.website"] = "Enter a valid http or https URL."; }
  }
  assertLengths(company, {
    legal_name: 240, company_type: 80, registered_address: 1000, country: 120, registration_number: 160,
    website: 500, imo_company_number: 80, tax_number: 160, authorized_representative_name: 160,
    authorized_representative_designation: 160, authorized_representative_email: 254, authorized_representative_phone: 30,
  }, errors, "company");
  if (Object.keys(errors).length) throw validationError(errors);
};

const accountQuery = `
  SELECT u.id AS user_id,u.full_name,u.username,u.email,u.phone,u.is_active,u.created_at,u.updated_at,
    cp.id AS client_profile_id,cp.designation,cp.declared_vessel_count,cp.verification_status,
    cp.verification_submitted_at,cp.verified_at,cp.verified_by_user_id,reviewer.full_name AS verified_by_name,
    cp.rejection_reason,cp.resubmission_count,
    cc.id AS company_id,cc.legal_name,cc.company_type,cc.registered_address,cc.country,cc.registration_number,
    cc.website,cc.imo_company_number,cc.tax_number,cc.authorized_representative_name,
    cc.authorized_representative_designation,cc.authorized_representative_email,cc.authorized_representative_phone
  FROM users u
  LEFT JOIN client_profiles cp ON cp.user_id=u.id
  LEFT JOIN users reviewer ON reviewer.id=cp.verified_by_user_id
  LEFT JOIN client_companies cc ON cc.client_profile_id=cp.id
  WHERE u.id=$1 AND u.role_id=3`;

export const loadAdminClient = async (queryable, userId) => {
  const base = await queryable.query(accountQuery, [userId]);
  if (!base.rows.length) return null;
  const row = base.rows[0];
  const profileId = row.client_profile_id;
  let vessels = { rows: [] }, services = { rows: [] }, documents = { rows: [] }, history = { rows: [] };
  if (profileId) {
    vessels = await queryable.query(`SELECT cov.id,cov.vessel_name,cov.imo_number,cov.vessel_type_id,cov.vessel_type_text,mvt.name AS vessel_type_name,cov.ownership_relationship,cov.operating_regions,cov.converted_vessel_id FROM client_onboarding_vessels cov LEFT JOIN master_vessel_types mvt ON mvt.id=cov.vessel_type_id WHERE cov.client_profile_id=$1 ORDER BY cov.id`, [profileId]);
    services = await queryable.query(`SELECT id,service_type_id,service_category_id,service_name_snapshot,other_service_text,created_at FROM client_required_services WHERE client_profile_id=$1 ORDER BY id`, [profileId]);
    documents = await queryable.query(`SELECT id,document_category,original_filename,mime_type,size_bytes,is_current,uploaded_at FROM client_verification_documents WHERE client_profile_id=$1 AND is_current=TRUE ORDER BY document_category`, [profileId]);
    history = await queryable.query(`SELECT e.id,e.previous_status,e.new_status,e.actor_user_id,actor.full_name AS actor_name,e.public_reason,e.internal_note,e.created_at FROM client_verification_events e LEFT JOIN users actor ON actor.id=e.actor_user_id WHERE e.client_profile_id=$1 ORDER BY e.created_at DESC,e.id DESC`, [profileId]);
  }
  const summary = await queryable.query(`SELECT
    (SELECT COUNT(*)::int FROM service_requests WHERE requester_user_id=$1) AS total_service_requests,
    (SELECT COUNT(*)::int FROM service_requests WHERE requester_user_id=$1 AND LOWER(status) <> ALL($2::text[])) AS active_service_requests,
    (SELECT COUNT(*)::int FROM vessels WHERE created_by_user_id=$1 AND is_active=TRUE) AS vessel_count,
    (SELECT COUNT(*)::int FROM quotations q JOIN service_requests sr ON sr.id=q.service_request_id WHERE sr.requester_user_id=$1 AND q.status='accepted') AS accepted_quotation_count,
    (SELECT COUNT(*)::int FROM expert_reviews WHERE reviewer_user_id=$1) AS review_count`, [userId, ACTIVE_REQUEST_STATUSES]);
  const recent = await queryable.query(`SELECT id,title,service_type,service_category,service_type_other,status,moderation_status,required_by,created_at FROM service_requests WHERE requester_user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 5`, [userId]);
  const op = summary.rows[0];
  const missingFormalRegistration = !profileId || (!row.verification_submitted_at && history.rows.length === 0);
  const hasImmutableHistory = [op.total_service_requests, op.vessel_count, op.accepted_quotation_count, op.review_count].some((value) => Number(value) > 0);
  return {
    account: { user_id: row.user_id, full_name: row.full_name, username: row.username, email: row.email, phone: row.phone, is_active: row.is_active, created_at: row.created_at, updated_at: row.updated_at },
    registration: profileId ? { client_profile_id: profileId, designation: row.designation, declared_vessel_count: row.declared_vessel_count, verification_status: row.verification_status, verification_submitted_at: row.verification_submitted_at, verified_at: row.verified_at, verified_by_user_id: row.verified_by_user_id, verified_by_name: row.verified_by_name, rejection_reason: row.rejection_reason, resubmission_count: row.resubmission_count } : null,
    company: row.company_id ? { company_id: row.company_id, legal_name: row.legal_name, company_type: row.company_type, registered_address: row.registered_address, country: row.country, registration_number: row.registration_number, website: row.website, imo_company_number: row.imo_company_number, tax_number: row.tax_number, authorized_representative_name: row.authorized_representative_name, authorized_representative_designation: row.authorized_representative_designation, authorized_representative_email: row.authorized_representative_email, authorized_representative_phone: row.authorized_representative_phone } : null,
    onboarding_vessels: vessels.rows,
    required_services: services.rows,
    documents: documents.rows,
    verification_history: history.rows,
    operational_summary: op,
    recent_service_requests: recent.rows,
    flags: { is_legacy: missingFormalRegistration, missing_registration_data: missingFormalRegistration, has_immutable_history: hasImmutableHistory },
  };
};

const ensureProfile = async (client, userId, profileId) => {
  if (profileId) return profileId;
  const inserted = await client.query(`INSERT INTO client_profiles (user_id,designation,declared_vessel_count,verification_status,verification_submitted_at,verified_at,verified_by_user_id) VALUES ($1,NULL,NULL,'pending',NULL,NULL,NULL) RETURNING id`, [userId]);
  return inserted.rows[0].id;
};

const updateColumns = async (client, table, values, allowed, keyColumn, keyValue) => {
  const supplied = ownFields(values, allowed);
  const entries = Object.entries(supplied);
  if (!entries.length) return;
  const params = entries.map(([, value]) => value);
  params.push(keyValue);
  await client.query(`UPDATE ${table} SET ${entries.map(([field], index) => `${field}=$${index + 1}`).join(",")},updated_at=CURRENT_TIMESTAMP WHERE ${keyColumn}=$${params.length}`, params);
};

const assertUniqueClientValues = async (client, userId, profileId, user, company) => {
  const errors = {};
  if (Object.hasOwn(user, "email")) {
    const duplicate = await client.query(`SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND id<>$2 LIMIT 1`, [normalized(user.email), userId]);
    if (duplicate.rows.length) errors["user.email"] = "Email is already in use.";
  }
  if (clean(company.registration_number) && clean(company.country)) {
    const duplicate = await client.query(`SELECT id FROM client_companies WHERE LOWER(TRIM(country))=LOWER(TRIM($1)) AND LOWER(TRIM(registration_number))=LOWER(TRIM($2)) AND client_profile_id<>$3 LIMIT 1`, [company.country, company.registration_number, profileId || 0]);
    if (duplicate.rows.length) errors["company.registration_number"] = "Registration number is already in use in this country.";
  }
  if (clean(company.imo_company_number)) {
    const duplicate = await client.query(`SELECT id FROM client_companies WHERE LOWER(TRIM(imo_company_number))=LOWER(TRIM($1)) AND client_profile_id<>$2 LIMIT 1`, [company.imo_company_number, profileId || 0]);
    if (duplicate.rows.length) errors["company.imo_company_number"] = "IMO Company Number is already in use.";
  }
  if (Object.keys(errors).length) throw validationError(errors);
};

export const updateAdminClient = async (userId, payload, actorUserId) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await client.query(`SELECT u.id,cp.id AS profile_id FROM users u LEFT JOIN client_profiles cp ON cp.user_id=u.id WHERE u.id=$1 AND u.role_id=3 FOR UPDATE OF u`, [userId]);
    if (!target.rows.length) throw Object.assign(new Error("Client not found"), { status: 404, code: "CLIENT_NOT_FOUND" });
    const user = ownFields(payload?.user, USER_FIELDS);
    const profile = ownFields(payload?.profile, PROFILE_FIELDS);
    const company = ownFields(payload?.company, COMPANY_FIELDS);
    if (Object.hasOwn(user, "email")) user.email = normalized(user.email);
    if (Object.hasOwn(user, "phone")) user.phone = nullable(user.phone);
    if (Object.hasOwn(profile, "designation")) profile.designation = nullable(profile.designation);
    if (Object.hasOwn(profile, "declared_vessel_count")) profile.declared_vessel_count = Number(profile.declared_vessel_count);
    for (const field of Object.keys(company)) company[field] = field.includes("email") ? (nullable(company[field]) && normalized(company[field])) : nullable(company[field]);
    const existingCompany = target.rows[0].profile_id ? await client.query(`SELECT id,legal_name,company_type,registered_address,country,registration_number,website,imo_company_number,tax_number,authorized_representative_name,authorized_representative_designation,authorized_representative_email,authorized_representative_phone FROM client_companies WHERE client_profile_id=$1`, [target.rows[0].profile_id]) : { rows: [] };
    validatePatch({ user, profile, company: { ...(existingCompany.rows[0] || {}), ...company } }, { creatingCompany: Object.keys(company).length > 0 && !existingCompany.rows.length });
    await assertUniqueClientValues(client, userId, target.rows[0].profile_id, user, { ...(existingCompany.rows[0] || {}), ...company });
    await updateColumns(client, "users", user, USER_FIELDS, "id", userId);
    let profileId = target.rows[0].profile_id;
    if (Object.keys(profile).length || Object.keys(company).length) profileId = await ensureProfile(client, userId, profileId);
    if (profileId && Object.keys(profile).length) await updateColumns(client, "client_profiles", profile, PROFILE_FIELDS, "id", profileId);
    if (profileId && Object.keys(company).length) {
      if (existingCompany.rows.length) await updateColumns(client, "client_companies", company, COMPANY_FIELDS, "client_profile_id", profileId);
      else {
        const merged = { ...company };
        await client.query(`INSERT INTO client_companies (client_profile_id,legal_name,company_type,registered_address,country,registration_number,website,imo_company_number,tax_number,authorized_representative_name,authorized_representative_designation,authorized_representative_email,authorized_representative_phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [profileId, ...COMPANY_FIELDS.map((field) => merged[field] ?? null)]);
      }
    }
    const sections = [Object.keys(user).length && "account", Object.keys(profile).length && "profile", Object.keys(company).length && "company"].filter(Boolean);
    await writeAdminAudit(client, { actorUserId, action: "client_updated", targetType: "client", targetId: userId, summary: `Updated Client sections: ${sections.join(", ") || "none"}` });
    await client.query("COMMIT");
    return await loadAdminClient(pool, userId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
};

const validImo = (value) => {
  const digits = clean(value).replace(/^IMO\s*/i, "").replace(/\s/g, "");
  if (!digits) return true;
  if (!/^\d{7}$/.test(digits)) return false;
  const total = digits.slice(0, 6).split("").reduce((sum, digit, index) => sum + Number(digit) * (7 - index), 0);
  return total % 10 === Number(digits[6]);
};

export const updateAdminClientVessels = async (userId, payload, actorUserId) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await client.query(`SELECT u.id,cp.id AS profile_id FROM users u LEFT JOIN client_profiles cp ON cp.user_id=u.id WHERE u.id=$1 AND u.role_id=3 FOR UPDATE OF u`, [userId]);
    if (!target.rows.length) throw Object.assign(new Error("Client not found"), { status: 404 });
    const count = Number(payload?.declared_vessel_count);
    const vessels = Array.isArray(payload?.vessels) ? payload.vessels : [];
    const errors = {};
    if (!Number.isInteger(count) || count < 0) errors.declared_vessel_count = "Enter a whole number of zero or more.";
    if (vessels.length > 250) errors.vessels = "No more than 250 onboarding vessels may be supplied.";
    vessels.forEach((vessel, index) => {
      if (!clean(vessel.vessel_name)) errors[`vessels.${index}.vessel_name`] = "Vessel name is required.";
      if (clean(vessel.vessel_name).length > 200) errors[`vessels.${index}.vessel_name`] = "Must be 200 characters or fewer.";
      if (!clean(vessel.ownership_relationship)) errors[`vessels.${index}.ownership_relationship`] = "Ownership or management relationship is required.";
      if (!validImo(vessel.imo_number)) errors[`vessels.${index}.imo_number`] = "Enter a valid seven-digit IMO number.";
    });
    if (Object.keys(errors).length) throw validationError(errors);
    const profileId = await ensureProfile(client, userId, target.rows[0].profile_id);
    const existing = await client.query(`SELECT id,vessel_name,imo_number,vessel_type_id,vessel_type_text,ownership_relationship,operating_regions,converted_vessel_id FROM client_onboarding_vessels WHERE client_profile_id=$1 FOR UPDATE`, [profileId]);
    const byId = new Map(existing.rows.map((row) => [Number(row.id), row]));
    const suppliedIds = new Set();
    for (let index = 0; index < vessels.length; index += 1) {
      const vessel = vessels[index];
      const id = vessel.id == null || vessel.id === "" ? null : Number(vessel.id);
      if (id && (suppliedIds.has(id) || !byId.has(id))) throw validationError({ [`vessels.${index}.id`]: "Vessel does not belong to this Client." });
      if (id) suppliedIds.add(id);
      const typeId = vessel.vessel_type_id ? Number(vessel.vessel_type_id) : null;
      if (typeId) {
        const validType = await client.query(`SELECT id FROM master_vessel_types WHERE id=$1`, [typeId]);
        if (!validType.rows.length) throw validationError({ [`vessels.${index}.vessel_type_id`]: "Select a valid vessel type." });
      }
      const values = [clean(vessel.vessel_name), nullable(vessel.imo_number)?.replace(/^IMO\s*/i, ""), typeId, nullable(vessel.vessel_type_text), clean(vessel.ownership_relationship), nullable(vessel.operating_regions)];
      if (id) {
        const old = byId.get(id);
        if (old.converted_vessel_id) {
          const changed = [old.vessel_name, old.imo_number, old.vessel_type_id, old.vessel_type_text, old.ownership_relationship, old.operating_regions].some((value, position) => String(value ?? "") !== String(values[position] ?? ""));
          if (changed) throw Object.assign(new Error("Converted onboarding vessels must be edited through the operational vessel workflow."), { status: 409, code: "CONVERTED_VESSEL_CONFLICT" });
        } else await client.query(`UPDATE client_onboarding_vessels SET vessel_name=$1,imo_number=$2,vessel_type_id=$3,vessel_type_text=$4,ownership_relationship=$5,operating_regions=$6,updated_at=CURRENT_TIMESTAMP WHERE id=$7 AND client_profile_id=$8`, [...values, id, profileId]);
      } else await client.query(`INSERT INTO client_onboarding_vessels (client_profile_id,vessel_name,imo_number,vessel_type_id,vessel_type_text,ownership_relationship,operating_regions) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [profileId, ...values]);
    }
    const removable = existing.rows.filter((row) => !row.converted_vessel_id && !suppliedIds.has(Number(row.id))).map((row) => row.id);
    if (removable.length) await client.query(`DELETE FROM client_onboarding_vessels WHERE client_profile_id=$1 AND id=ANY($2::int[]) AND converted_vessel_id IS NULL`, [profileId, removable]);
    await client.query(`UPDATE client_profiles SET declared_vessel_count=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2`, [count, profileId]);
    await writeAdminAudit(client, { actorUserId, action: "client_updated", targetType: "client", targetId: userId, summary: `Updated Client fleet section (${vessels.length} submitted rows)` });
    await client.query("COMMIT");
    return await loadAdminClient(pool, userId);
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
};

export const updateAdminClientServices = async (userId, payload, actorUserId) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await client.query(`SELECT u.id,cp.id AS profile_id FROM users u LEFT JOIN client_profiles cp ON cp.user_id=u.id WHERE u.id=$1 AND u.role_id=3 FOR UPDATE OF u`, [userId]);
    if (!target.rows.length) throw Object.assign(new Error("Client not found"), { status: 404 });
    const services = Array.isArray(payload?.services) ? payload.services : null;
    if (!services) throw validationError({ services: "Services must be an array." });
    if (services.length > 100) throw validationError({ services: "No more than 100 services may be supplied." });
    for (let index = 0; index < services.length; index += 1) {
      const service = services[index];
      if (!clean(service.service_name_snapshot)) throw validationError({ [`services.${index}.service_name_snapshot`]: "Service name is required." });
      if (clean(service.service_name_snapshot).length > 240) throw validationError({ [`services.${index}.service_name_snapshot`]: "Must be 240 characters or fewer." });
      const typeId = service.service_type_id ? Number(service.service_type_id) : null;
      const categoryId = service.service_category_id ? Number(service.service_category_id) : null;
      if (typeId) {
        const validType = await client.query(`SELECT id FROM master_service_types WHERE id=$1`, [typeId]);
        if (!validType.rows.length) throw validationError({ [`services.${index}.service_type_id`]: "Select a valid service type." });
      }
      if (categoryId) {
        const validCategory = await client.query(`SELECT id,service_type_id FROM master_service_categories WHERE id=$1`, [categoryId]);
        if (!validCategory.rows.length || (typeId && Number(validCategory.rows[0].service_type_id) !== typeId)) throw validationError({ [`services.${index}.service_category_id`]: "Select a valid service category." });
      }
    }
    const profileId = await ensureProfile(client, userId, target.rows[0].profile_id);
    await client.query(`DELETE FROM client_required_services WHERE client_profile_id=$1`, [profileId]);
    for (const service of services) await client.query(`INSERT INTO client_required_services (client_profile_id,service_type_id,service_category_id,service_name_snapshot,other_service_text) VALUES ($1,$2,$3,$4,$5)`, [profileId, service.service_type_id ? Number(service.service_type_id) : null, service.service_category_id ? Number(service.service_category_id) : null, clean(service.service_name_snapshot), nullable(service.other_service_text)]);
    await writeAdminAudit(client, { actorUserId, action: "client_updated", targetType: "client", targetId: userId, summary: `Updated Client required-services section (${services.length} selections)` });
    await client.query("COMMIT");
    return await loadAdminClient(pool, userId);
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
};
