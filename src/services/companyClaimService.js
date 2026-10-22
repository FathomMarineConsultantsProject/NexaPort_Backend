import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import { writeAdminAudit } from "./adminAuditService.js";
import { createPresignedGetUrl, createPresignedPutUrl } from "../utils/s3Presign.js";
import { inspectPrivateObject } from "./privateObjectService.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COM = /^COM-[0-9A-F]{32}$/;
const MIME = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const clean = (value) => String(value ?? "").trim();
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const validId = (id) => { if (!UUID.test(String(id))) fail(400, "INVALID_ID", "Invalid company or claim ID."); return id; };
const bounded = (value, fallback, max) => Math.min(max, Math.max(1, Number.parseInt(value, 10) || fallback));

export async function searchCompanies(query = {}, db = pool) {
  const term = clean(query.q);
  if (term.length < 2 || term.length > 120) fail(400, "INVALID_SEARCH", "Enter 2 to 120 search characters.");
  const page = bounded(query.page, 1, 100000);
  const limit = bounded(query.limit, 12, 30);
  const result = await db.query(`SELECT e.id,e.public_id,e.company_name,e.city,e.country,
    ARRAY(SELECT t.directory_type FROM maritime_directory_entity_types t WHERE t.entity_id=e.id ORDER BY t.directory_type) AS directory_types
    FROM maritime_directory_entities e WHERE e.is_active=true AND e.review_status='approved'
      AND (e.public_id=upper($1) OR e.company_name ILIKE '%'||$1||'%' OR e.city ILIKE $1||'%' OR e.country ILIKE $1||'%')
    ORDER BY CASE WHEN e.public_id=upper($1) THEN 0 WHEN lower(e.company_name)=lower($1) THEN 1 ELSE 2 END,e.company_name,e.id
    LIMIT $2 OFFSET $3`, [term, limit, (page - 1) * limit]);
  return { data: result.rows, page, limit, hasMore: result.rows.length === limit };
}

export async function getPublicCompany(id, db = pool) {
  const byCom = COM.test(String(id));
  if (!byCom) validId(id);
  const result = await db.query(`SELECT e.id,e.public_id,e.company_name,e.description,e.city,e.country,e.website,
    EXISTS(SELECT 1 FROM maritime_company_memberships m WHERE m.entity_id=e.id AND m.status='approved') AS has_existing_association,
    ARRAY(SELECT t.directory_type FROM maritime_directory_entity_types t WHERE t.entity_id=e.id ORDER BY t.directory_type) AS directory_types
    FROM maritime_directory_entities e WHERE ${byCom ? "e.public_id" : "e.id"}=$1 AND e.is_active=true AND e.review_status='approved'`, [id]);
  if (!result.rows.length) fail(404, "COMPANY_NOT_FOUND", "Company not found.");
  return result.rows[0];
}

export async function companyAccess(userId, entityId, db = pool) {
  const result = await db.query(`SELECT membership_role FROM maritime_company_memberships WHERE user_id=$1 AND entity_id=$2 AND status='approved'`, [userId, entityId]);
  return result.rows[0]?.membership_role || null;
}

export async function listManagedCompanies(userId, db = pool) {
  const result = await db.query(`SELECT e.id,e.public_id,e.company_name,e.review_status,m.membership_role
    FROM maritime_company_memberships m JOIN maritime_directory_entities e ON e.id=m.entity_id
    WHERE m.user_id=$1 AND m.status='approved' ORDER BY e.company_name,e.id`, [userId]);
  return result.rows;
}

export async function ownClaims(userId, db = pool) {
  const result = await db.query(`SELECT c.id,c.entity_id,e.public_id,e.company_name,c.status,c.applicant_designation,
    c.created_at,c.reviewed_at,CASE WHEN c.status='rejected' THEN c.public_reason END AS decision_note
    FROM maritime_company_claims c JOIN maritime_directory_entities e ON e.id=c.entity_id
    WHERE c.claimant_user_id=$1 ORDER BY c.created_at DESC LIMIT 100`, [userId]);
  return result.rows;
}

export async function submitClaim(user, input = {}, db = pool) {
  input ||= {};
  const entityId = validId(input.entityId);
  const designation = clean(input.designation);
  const businessEmail = clean(input.businessEmail).toLowerCase();
  const relationship = clean(input.relationship);
  const registrationNumber = clean(input.registrationNumber) || null;
  const website = clean(input.website) || null;
  if (!designation || designation.length > 160) fail(400, "INVALID_DESIGNATION", "Enter your company role (up to 160 characters).");
  if (!/^\S+@\S+\.\S+$/.test(businessEmail) || businessEmail.length > 320) fail(400, "INVALID_EMAIL", "Enter a valid business email.");
  if (relationship.length < 20 || relationship.length > 3000) fail(400, "INVALID_RELATIONSHIP", "Explain your relationship in 20 to 3000 characters.");
  if (registrationNumber?.length > 160) fail(400, "INVALID_REGISTRATION", "Registration number is too long.");
  if (website) { try { const url = new URL(website); if (!["http:", "https:"].includes(url.protocol) || website.length > 500) throw new Error(); } catch { fail(400, "INVALID_WEBSITE", "Enter an HTTP or HTTPS website URL."); } }
  const company = await getPublicCompany(entityId, db);
  if (await companyAccess(user.id, company.id, db)) fail(409, "ALREADY_MANAGED", "You already manage this company.");
  const existing = await db.query("SELECT 1 FROM maritime_company_claims WHERE entity_id=$1 AND claimant_user_id=$2 AND status='pending'", [entityId, user.id]);
  if (existing.rows.length) fail(409, "CLAIM_PENDING", "Your claim is already pending review.");
  let evidenceKey = null, evidenceType = null, evidenceSize = null;
  if (input.evidence) {
    const { key, contentType, size } = input.evidence;
    if (!MIME[contentType] || !Number.isInteger(Number(size)) || Number(size) < 1 || Number(size) > 5 * 1024 * 1024 ||
      typeof key !== "string" || !new RegExp(`^company-claims/${user.id}/[0-9a-f-]{36}\\.${MIME[contentType]}$`).test(key)) fail(400, "INVALID_EVIDENCE", "Invalid supporting document.");
    const object = await inspectPrivateObject(key);
    if (object.contentLength !== Number(size) || object.contentType !== contentType) fail(400, "EVIDENCE_MISMATCH", "Uploaded document does not match the selected file.");
    evidenceKey = key; evidenceType = contentType; evidenceSize = Number(size);
  }
  try {
    const result = await db.query(`INSERT INTO maritime_company_claims
      (entity_id,claimant_user_id,applicant_name,applicant_designation,applicant_business_email,company_registration_number,company_website,relationship_description,evidence_s3_key,evidence_mime_type,evidence_size_bytes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,status,created_at`,
      [entityId,user.id,clean(user.full_name),designation,businessEmail,registrationNumber,website,relationship,evidenceKey,evidenceType,evidenceSize]);
    return result.rows[0];
  } catch (error) {
    if (error.code === "23505") fail(409, "CLAIM_PENDING", "Your claim is already pending review.");
    throw error;
  }
}

export function createClaimEvidenceUpload(userId, input = {}) {
  input ||= {};
  const type = input.contentType;
  const size = Number(input.size);
  if (!MIME[type] || !Number.isInteger(size) || size < 1 || size > 5 * 1024 * 1024) fail(400, "INVALID_EVIDENCE", "Use PDF, JPEG, PNG or WebP up to 5 MB.");
  const key = `company-claims/${userId}/${randomUUID()}.${MIME[type]}`;
  return { key, uploadUrl: createPresignedPutUrl({ key, contentType: type, expiresIn: 300 }), expiresIn: 300 };
}

export async function adminClaims(query = {}, db = pool) {
  const status = clean(query.status) || "pending";
  if (!["pending", "approved", "rejected", "all"].includes(status)) fail(400, "INVALID_STATUS", "Invalid status filter.");
  const page = bounded(query.page, 1, 100000);
  const limit = bounded(query.limit, 20, 50);
  const result = await db.query(`SELECT c.id,c.entity_id,c.claimant_user_id,c.applicant_designation,c.status,c.created_at,c.reviewed_at,
    c.evidence_s3_key IS NOT NULL AS has_evidence,e.company_name,e.public_id,u.full_name AS claimant_name,u.email AS account_email,
    ARRAY(SELECT t.directory_type FROM maritime_directory_entity_types t WHERE t.entity_id=e.id ORDER BY t.directory_type) AS directory_types,
    EXISTS(SELECT 1 FROM maritime_company_memberships m WHERE m.entity_id=e.id AND m.status='approved') AS has_existing_association
    FROM maritime_company_claims c JOIN maritime_directory_entities e ON e.id=c.entity_id JOIN users u ON u.id=c.claimant_user_id
    WHERE ($1='all' OR c.status=$1) ORDER BY c.created_at DESC,c.id LIMIT $2 OFFSET $3`, [status,limit,(page-1)*limit]);
  return { data: result.rows, page, limit, hasMore: result.rows.length === limit };
}

export async function adminClaimDetail(id, db = pool) {
  validId(id);
  const result = await db.query(`SELECT c.*,e.company_name,e.public_id,e.description,e.country,e.city,e.data_source,
    u.full_name AS claimant_account_name,u.email AS claimant_account_email
    FROM maritime_company_claims c JOIN maritime_directory_entities e ON e.id=c.entity_id
    JOIN users u ON u.id=c.claimant_user_id WHERE c.id=$1`, [id]);
  if (!result.rows.length) fail(404, "CLAIM_NOT_FOUND", "Claim not found.");
  const claim = result.rows[0];
  const [sources,members,history,types] = await Promise.all([
    db.query("SELECT source_name,source_external_id,source_url FROM directory_entity_sources WHERE entity_id=$1 ORDER BY source_name", [claim.entity_id]),
    db.query(`SELECT m.user_id,m.membership_role,m.status,u.full_name,u.email FROM maritime_company_memberships m JOIN users u ON u.id=m.user_id WHERE m.entity_id=$1`, [claim.entity_id]),
    db.query("SELECT id,claimant_user_id,status,created_at,reviewed_at FROM maritime_company_claims WHERE entity_id=$1 ORDER BY created_at DESC LIMIT 100", [claim.entity_id]),
    db.query("SELECT directory_type FROM maritime_directory_entity_types WHERE entity_id=$1 ORDER BY directory_type", [claim.entity_id]),
  ]);
  return { ...claim, evidence_s3_key: undefined, has_evidence: Boolean(claim.evidence_s3_key), sources: sources.rows, members: members.rows, history: history.rows, directory_types: types.rows.map(row => row.directory_type) };
}

export async function claimEvidenceUrl(id, db = pool) {
  validId(id);
  const result = await db.query("SELECT evidence_s3_key FROM maritime_company_claims WHERE id=$1", [id]);
  if (!result.rows[0]?.evidence_s3_key) fail(404, "EVIDENCE_NOT_FOUND", "No supporting document was supplied.");
  return createPresignedGetUrl({ key: result.rows[0].evidence_s3_key, expiresInSeconds: 300 });
}

export async function decideClaim(id, action, reviewer, notes, database = pool, publicReason = null) {
  validId(id);
  if (!["approve", "reject"].includes(action)) fail(400, "INVALID_ACTION", "Invalid decision.");
  const reason = clean(notes);
  const applicantReason = clean(publicReason);
  if (action === "reject" && !applicantReason) fail(400, "REASON_REQUIRED", "Record a reason to share with the applicant.");
  if (reason.length > 3000) fail(400, "INVALID_NOTES", "Review notes are too long.");
  if (applicantReason.length > 1000) fail(400, "INVALID_REASON", "Applicant reason is too long.");
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM maritime_company_claims WHERE id=$1 FOR UPDATE", [id]);
    const claim = found.rows[0];
    if (!claim) fail(404, "CLAIM_NOT_FOUND", "Claim not found.");
    if (claim.status !== "pending") fail(409, "CLAIM_DECIDED", "This claim has already been decided.");
    if (Number(claim.claimant_user_id) === Number(reviewer.id)) fail(403, "SELF_REVIEW", "You cannot review your own claim.");
    await client.query("SELECT id FROM maritime_directory_entities WHERE id=$1 FOR UPDATE", [claim.entity_id]);
    if (action === "approve") {
      const existing = await client.query(`SELECT m.user_id,m.membership_role FROM maritime_company_memberships m
        WHERE m.entity_id=$1 AND m.status='approved' FOR UPDATE`, [claim.entity_id]);
      if (existing.rows.some(row => Number(row.user_id) === Number(claim.claimant_user_id))) fail(409, "ALREADY_MANAGED", "Applicant already manages this company.");
      const role = existing.rows.length ? "editor" : "owner";
      if (existing.rows.length && !reason) fail(400, "CONFLICT_NOTES_REQUIRED", "Explain why another representative should be added.");
      await client.query(`INSERT INTO maritime_company_memberships(entity_id,user_id,membership_role,approved_by_user_id)
        VALUES($1,$2,$3,$4) ON CONFLICT(entity_id,user_id) DO UPDATE SET
        membership_role=EXCLUDED.membership_role,status='approved',approved_by_user_id=EXCLUDED.approved_by_user_id,
        approved_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
        WHERE maritime_company_memberships.status='revoked'`, [claim.entity_id,claim.claimant_user_id,role,reviewer.id]);
      await client.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,4) ON CONFLICT(user_id,role_id) DO NOTHING", [claim.claimant_user_id]);
    }
    const status = action === "approve" ? "approved" : "rejected";
    await client.query("UPDATE maritime_company_claims SET status=$1,reviewer_user_id=$2,reviewed_at=CURRENT_TIMESTAMP,review_notes=$3,public_reason=$4,updated_at=CURRENT_TIMESTAMP WHERE id=$5", [status,reviewer.id,reason || null,action === "reject" ? applicantReason : null,id]);
    await writeAdminAudit(client,{ actorUserId: reviewer.id, action: `company_claim_${status}`, targetType: "maritime_company_claim", targetId: id, summary: `${status} company claim for ${claim.entity_id}`, reason: reason || null });
    await client.query("COMMIT");
    return { id, status, entityId: claim.entity_id };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") fail(409, "OWNERSHIP_CONFLICT", "Company association changed. Review the current company state.");
    throw error;
  } finally { client.release(); }
}
