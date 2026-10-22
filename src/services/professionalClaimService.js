import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import { createPresignedGetUrl, createPresignedPutUrl } from "../utils/s3Presign.js";
import { inspectPrivateObject } from "./privateObjectService.js";
import { writeAdminAudit } from "./adminAuditService.js";

const SOURCES = Object.freeze({
  expert: { table: "experts", name: "full_name", reference: "COALESCE(nexaport_id,public_id)", eligible: "user_id IS NULL" },
  flag_inspector: { table: "flag_inspectors", name: "full_name", reference: "public_id", eligible: "is_active=true AND NULLIF(BTRIM(full_name),'') IS NOT NULL" },
  accredited_inspector: { table: "accredited_inspectors", name: "full_name", reference: "public_id", eligible: "is_active=true AND EXISTS (SELECT 1 FROM public.accreditation_schemes WHERE id=scheme_id AND is_active=true) AND NULLIF(BTRIM(full_name),'') IS NOT NULL" },
  appointed_surveyor: { table: "appointed_ship_surveyors", name: "full_name", reference: "public_id", eligible: "is_active=true AND NULLIF(BTRIM(full_name),'') IS NOT NULL" },
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const clean = value => String(value ?? "").trim();
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const target = (type, id) => {
  const source = SOURCES[type];
  if (!source || !/^[0-9A-Za-z-]{1,100}$/.test(String(id))) fail(400, "INVALID_TARGET", "Invalid professional target.");
  return source;
};

export async function getProfessional(type, id, db = pool) {
  const source = target(type, id);
  const row = (await db.query(`SELECT id::text AS source_id,${source.name} AS name,${source.reference} AS public_id,
    country,${source.eligible} AS eligible FROM public.${source.table}
    WHERE (id::text=$1 OR ${source.reference}=$1) AND ${source.eligible} LIMIT 1`, [id])).rows[0];
  if (!row) fail(404, "PROFILE_NOT_FOUND", "This individual profile is unavailable for claiming.");
  return { source_type: type, ...row };
}

export async function searchProfessionals(input = {}, db = pool) {
  const q = clean(input.q);
  if (q.length < 2 || q.length > 120) fail(400, "INVALID_SEARCH", "Enter 2 to 120 search characters.");
  const type = clean(input.type);
  if (type && !SOURCES[type]) fail(400, "INVALID_TARGET", "Unsupported professional type.");
  const rows = [];
  for (const [key, source] of Object.entries(SOURCES)) {
    if (type && type !== key) continue;
    const result = await db.query(`SELECT id::text AS source_id,${source.name} AS name,
      ${source.reference} AS public_id,country FROM public.${source.table}
      WHERE ${source.eligible} AND (${source.name} ILIKE '%'||$1||'%' OR ${source.reference}=$2)
      ORDER BY ${source.name},id LIMIT 25`, [q, q.toUpperCase()]);
    rows.push(...result.rows.map(row => ({ source_type: key, ...row })));
  }
  return rows.slice(0, 40);
}

export async function getClaimState(type, id, userId = null, db = pool) {
  const profile = await getProfessional(type, id, db);
  const [members, pending, mine] = await Promise.all([
    db.query(`SELECT user_id,status FROM professional_memberships WHERE source_type=$1 AND source_id=$2 AND status='approved'`, [type, profile.source_id]),
    db.query(`SELECT count(*)::int AS count FROM professional_claims WHERE source_type=$1 AND source_id=$2 AND status='pending'`, [type, profile.source_id]),
    userId ? db.query(`SELECT id,status,public_reason FROM professional_claims WHERE source_type=$1 AND source_id=$2 AND claimant_user_id=$3 ORDER BY created_at DESC LIMIT 1`, [type, profile.source_id, userId]) : Promise.resolve({ rows: [] }),
  ]);
  const own = mine.rows[0];
  const mineApproved = members.rows.some(row => Number(row.user_id) === Number(userId));
  const state = mineApproved ? "managed" : members.rows.length ? "verified_elsewhere" : own?.status === "pending" ? "pending" : pending.rows[0].count ? "pending_elsewhere" : own?.status === "rejected" ? "rejected" : "unclaimed";
  return { ...profile, account_claim_state: state, own_claim: own || null };
}

export async function registerClaimAccount(input = {}, db = pool) {
  const { sourceType, sourceId } = input;
  const fullName = clean(input.fullName), email = clean(input.email).toLowerCase(), username = clean(input.username);
  if (!fullName || fullName.length > 200 || !/^\S+@\S+\.\S+$/.test(email) || email.length > 320 || !username || username.length > 100)
    fail(400, "INVALID_ACCOUNT", "Enter a name, valid email and username.");
  if (typeof input.password !== "string" || input.password.length < 8 || !/[A-Za-z]/.test(input.password) || !/\d/.test(input.password) || input.confirmPassword !== input.password)
    fail(400, "INVALID_PASSWORD", "Use matching passwords of at least eight characters with letters and numbers.");
  const profile = await getProfessional(sourceType, sourceId, db);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT 1 FROM users WHERE lower(email)=$1 OR lower(username)=lower($2)", [email, username]);
    if (existing.rows.length) fail(409, "ACCOUNT_EXISTS", "Email or username is already registered. Sign in to claim.");
    const passwordHash = await bcrypt.hash(input.password, 10);
    const user = (await client.query(`INSERT INTO users(full_name,email,username,password_hash,role_id,is_active)
      VALUES($1,$2,$3,$4,2,true) RETURNING id,full_name,email,username,role_id,is_active`, [fullName,email,username,passwordHash])).rows[0];
    await client.query(`INSERT INTO professional_claim_account_intents(user_id,source_type,source_id)
      VALUES($1,$2,$3)`, [user.id,profile.source_type,profile.source_id]);
    await client.query("COMMIT");
    return { user, target: profile };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") fail(409, "ACCOUNT_EXISTS", "Email or username is already registered. Sign in to claim.");
    throw error;
  } finally { client.release(); }
}

export async function submitProfessionalClaim(user, input = {}, db = pool) {
  const profile = await getProfessional(input.sourceType, input.sourceId, db);
  const name = clean(input.applicantName) || clean(user.full_name);
  const email = clean(input.businessEmail).toLowerCase();
  const relationship = clean(input.relationship);
  const reference = clean(input.professionalReference) || null;
  if (!name || name.length > 200 || !/^\S+@\S+\.\S+$/.test(email) || email.length > 320 || relationship.length < 20 || relationship.length > 3000 || (reference && reference.length > 200))
    fail(400, "INVALID_CLAIM", "Enter your name, business email and a 20–3000 character identity explanation.");
  const approved = await db.query(`SELECT 1 FROM professional_memberships WHERE source_type=$1 AND source_id=$2 AND user_id=$3 AND status='approved'`, [profile.source_type,profile.source_id,user.id]);
  if (approved.rows.length) fail(409, "ALREADY_MANAGED", "You already manage this profile.");
  let evidenceKey = null, evidenceType = null, evidenceSize = null;
  if (input.evidence) {
    const { key, contentType, size } = input.evidence;
    const expected = MIME[contentType];
    if (!expected || !Number.isInteger(Number(size)) || Number(size) < 1 || Number(size) > 5242880 ||
      typeof key !== "string" || !new RegExp(`^professional-claims/${user.id}/[0-9a-f-]{36}\\.${expected}$`).test(key))
      fail(400, "INVALID_EVIDENCE", "Invalid supporting file.");
    const object = await inspectPrivateObject(key);
    if (object.contentLength !== Number(size) || object.contentType !== contentType) fail(400, "EVIDENCE_MISMATCH", "Uploaded file does not match the selected file.");
    evidenceKey = key; evidenceType = contentType; evidenceSize = Number(size);
  }
  try {
    return (await db.query(`INSERT INTO professional_claims(source_type,source_id,claimant_user_id,applicant_name,business_email,
      relationship_description,professional_reference,evidence_s3_key,evidence_mime_type,evidence_size_bytes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,status,created_at`,
      [profile.source_type,profile.source_id,user.id,name,email,relationship,reference,evidenceKey,evidenceType,evidenceSize])).rows[0];
  } catch (error) { if (error.code === "23505") fail(409, "CLAIM_PENDING", "Your claim is already pending."); throw error; }
}

export function professionalEvidenceUpload(userId, input = {}) {
  const ext = MIME[input.contentType], size = Number(input.size);
  if (!ext || !Number.isInteger(size) || size < 1 || size > 5242880) fail(400, "INVALID_EVIDENCE", "Use PDF or image up to 5 MB.");
  const key = `professional-claims/${userId}/${randomUUID()}.${ext}`;
  return { key, uploadUrl: createPresignedPutUrl({ key, contentType: input.contentType, expiresIn: 300 }), expiresIn: 300 };
}

export async function ownProfessionalClaims(userId, db = pool) {
  return (await db.query(`SELECT id,source_type,source_id,status,created_at,reviewed_at,decision_note FROM (
    SELECT id,source_type,source_id,status,created_at,reviewed_at,
      CASE WHEN status='rejected' THEN public_reason END AS decision_note
      FROM professional_claims WHERE claimant_user_id=$1
    UNION ALL
    SELECT NULL::uuid,i.source_type,i.source_id,'not_submitted'::text,i.created_at,NULL::timestamptz,NULL::text
      FROM professional_claim_account_intents i WHERE i.user_id=$1
      AND NOT EXISTS(SELECT 1 FROM professional_claims c WHERE c.claimant_user_id=i.user_id
        AND c.source_type=i.source_type AND c.source_id=i.source_id)
    ) claims ORDER BY created_at DESC LIMIT 100`, [userId])).rows;
}
export async function managedProfessionals(userId, db = pool) {
  const links = (await db.query(`SELECT source_type,source_id,approved_at FROM professional_memberships
    WHERE user_id=$1 AND status='approved' ORDER BY approved_at`, [userId])).rows;
  return Promise.all(links.map(async link => ({ ...link, profile: await getProfessional(link.source_type,link.source_id,db) })));
}
export async function adminProfessionalClaims(input = {}, db = pool) {
  const status = clean(input.status) || "pending";
  if (!["pending","approved","rejected","disputed","all"].includes(status)) fail(400,"INVALID_STATUS","Invalid status filter.");
  return (await db.query(`SELECT c.id,c.source_type,c.source_id,c.claimant_user_id,c.applicant_name,c.status,c.created_at,
    c.evidence_s3_key IS NOT NULL AS has_evidence,u.email AS account_email
    FROM professional_claims c JOIN users u ON u.id=c.claimant_user_id
    WHERE ($1='all' OR c.status=$1) ORDER BY c.created_at DESC LIMIT 100`, [status])).rows;
}
export async function adminProfessionalDetail(id, db = pool) {
  if (!UUID.test(id)) fail(400,"INVALID_ID","Invalid claim ID.");
  const claim = (await db.query(`SELECT c.*,u.email AS account_email FROM professional_claims c
    JOIN users u ON u.id=c.claimant_user_id WHERE c.id=$1`, [id])).rows[0];
  if (!claim) fail(404,"CLAIM_NOT_FOUND","Claim not found.");
  const [profile,members,history] = await Promise.all([
    getProfessional(claim.source_type,claim.source_id,db),
    db.query(`SELECT m.user_id,m.status,m.approved_at,m.approved_by_user_id,u.full_name,u.email
      FROM professional_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.source_type=$1 AND m.source_id=$2`, [claim.source_type,claim.source_id]),
    db.query(`SELECT id,status,claimant_user_id,reviewer_user_id,created_at,reviewed_at
      FROM professional_claims WHERE source_type=$1 AND source_id=$2 ORDER BY created_at DESC`, [claim.source_type,claim.source_id]),
  ]);
  const { evidence_s3_key, ...safeClaim } = claim;
  return { ...safeClaim, has_evidence: Boolean(evidence_s3_key), profile, members: members.rows, history: history.rows };
}
export async function adminProfessionalTargetStatus(type,id,db=pool) {
  const profile=await getProfessional(type,id,db);
  const [members,history]=await Promise.all([
    db.query(`SELECT m.user_id,m.status,m.approved_at,m.approved_by_user_id,m.revoked_at,u.full_name,u.email
      FROM professional_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.source_type=$1 AND m.source_id=$2 ORDER BY m.approved_at DESC`,[type,profile.source_id]),
    db.query(`SELECT id,claimant_user_id,status,reviewer_user_id,created_at,reviewed_at
      FROM professional_claims WHERE source_type=$1 AND source_id=$2 ORDER BY created_at DESC LIMIT 100`,[type,profile.source_id]),
  ]);
  return {profile,members:members.rows,history:history.rows};
}
export async function professionalEvidenceUrl(id, db = pool) {
  if (!UUID.test(id)) fail(400,"INVALID_ID","Invalid claim ID.");
  const key = (await db.query("SELECT evidence_s3_key FROM professional_claims WHERE id=$1", [id])).rows[0]?.evidence_s3_key;
  if (!key) fail(404,"EVIDENCE_NOT_FOUND","No evidence supplied.");
  return createPresignedGetUrl({ key, expiresInSeconds: 300 });
}

export async function decideProfessionalClaim(id, action, reviewer, notes = "", publicReason = "", db = pool) {
  if (!UUID.test(id) || !["approve","reject","dispute"].includes(action)) fail(400,"INVALID_DECISION","Invalid decision.");
  const reason = clean(notes), shared = clean(publicReason);
  if (action === "reject" && !shared) fail(400,"REASON_REQUIRED","Enter a reason for the applicant.");
  if (reason.length > 3000 || shared.length > 1000) fail(400,"INVALID_NOTES","Review note is too long.");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const claim = (await client.query("SELECT * FROM professional_claims WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!claim) fail(404,"CLAIM_NOT_FOUND","Claim not found.");
    if (claim.status !== "pending") fail(409,"CLAIM_DECIDED","Claim has already been decided.");
    if (Number(claim.claimant_user_id) === Number(reviewer.id)) fail(403,"SELF_REVIEW","You cannot review your own claim.");
    const source = target(claim.source_type,claim.source_id);
    const locked = (await client.query(`SELECT id::text AS id,${source.eligible} AS eligible FROM public.${source.table}
      WHERE id::text=$1 FOR UPDATE`, [claim.source_id])).rows[0];
    if (!locked?.eligible) fail(409,"TARGET_INELIGIBLE","Profile is no longer eligible.");
    const existing = (await client.query(`SELECT user_id FROM professional_memberships
      WHERE source_type=$1 AND source_id=$2 AND status='approved' FOR UPDATE`, [claim.source_type,claim.source_id])).rows;
    const competing = (await client.query(`SELECT count(*)::int AS count FROM professional_claims
      WHERE source_type=$1 AND source_id=$2 AND status='pending' AND id<>$3`, [claim.source_type,claim.source_id,id])).rows[0].count;
    if (action === "approve") {
      if (existing.length) fail(409,"CONTROLLER_EXISTS","This profile already has a verified controller. Review a dispute first.");
      if (competing && !reason) fail(400,"COMPETITION_NOTES_REQUIRED","Record how competing claims were resolved.");
      await client.query(`INSERT INTO professional_memberships(source_type,source_id,user_id,claim_id,approved_by_user_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_type,source_id,user_id) DO UPDATE SET
        status='approved',claim_id=EXCLUDED.claim_id,approved_by_user_id=EXCLUDED.approved_by_user_id,
        approved_at=now(),revoked_by_user_id=NULL,revoked_at=NULL
        WHERE professional_memberships.status='revoked'`, [claim.source_type,claim.source_id,claim.claimant_user_id,id,reviewer.id]);
      await client.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,2) ON CONFLICT(user_id,role_id) DO NOTHING", [claim.claimant_user_id]);
    }
    const status = action === "approve" ? "approved" : action === "dispute" ? "disputed" : "rejected";
    await client.query(`UPDATE professional_claims SET status=$1,reviewer_user_id=$2,reviewed_at=now(),
      review_notes=$3,public_reason=$4,updated_at=now() WHERE id=$5`, [status,reviewer.id,reason || null,status === "rejected" ? shared : null,id]);
    await writeAdminAudit(client,{ actorUserId: reviewer.id, action: `professional_claim_${status}`,
      targetType: "professional_claim",targetId: id,summary: `${status} ${claim.source_type}:${claim.source_id}`,reason: reason || null });
    await client.query("COMMIT");
    return { id,status,sourceType: claim.source_type,sourceId: claim.source_id };
  } catch (error) { await client.query("ROLLBACK"); if (error.code === "23505") fail(409,"CONTROLLER_EXISTS","Profile controller changed. Review current state."); throw error; }
  finally { client.release(); }
}

export async function updateProfessionalOverlay(userId, type, id, input = {}, db = pool) {
  const profile = await getProfessional(type,id,db);
  const membership = (await db.query(`SELECT 1 FROM professional_memberships WHERE source_type=$1 AND source_id=$2 AND user_id=$3 AND status='approved'`, [type,profile.source_id,userId])).rows[0];
  if (!membership) fail(403,"NOT_CONTROLLER","Approved profile access is required.");
  const biography = clean(input.biography), email = clean(input.publicEmail), phone = clean(input.publicPhone), availability = clean(input.availability);
  if (biography.length > 3000 || email.length > 320 || (email && !/^\S+@\S+\.\S+$/.test(email)) || phone.length > 80 || availability.length > 100)
    fail(400,"INVALID_PROFILE","Check the profile fields.");
  return (await db.query(`INSERT INTO professional_profile_overrides(source_type,source_id,user_id,biography,public_email,public_phone,availability)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_type,source_id,user_id) DO UPDATE SET
    biography=EXCLUDED.biography,public_email=EXCLUDED.public_email,public_phone=EXCLUDED.public_phone,
    availability=EXCLUDED.availability,updated_at=now() RETURNING *`,
    [type,profile.source_id,userId,biography || null,email || null,phone || null,availability || null])).rows[0];
}
export async function getProfessionalOverlay(userId, type, id, db = pool) {
  const profile = await getProfessional(type,id,db);
  const membership = (await db.query(`SELECT 1 FROM professional_memberships WHERE source_type=$1 AND source_id=$2 AND user_id=$3 AND status='approved'`, [type,profile.source_id,userId])).rows[0];
  if (!membership) fail(403,"NOT_CONTROLLER","Approved profile access is required.");
  const overlay = (await db.query(`SELECT biography,public_email,public_phone,availability,updated_at
    FROM professional_profile_overrides WHERE source_type=$1 AND source_id=$2 AND user_id=$3`, [type,profile.source_id,userId])).rows[0];
  return { profile, overlay: overlay || null };
}

export async function revokeProfessionalMembership(type,id,userId,reviewer,notes,db=pool) {
  const reason=clean(notes);
  if (reason.length<10 || reason.length>3000) fail(400,"REASON_REQUIRED","Record a 10–3000 character revocation reason.");
  const profile=await getProfessional(type,id,db);
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM public.${SOURCES[type].table} WHERE id::text=$1 FOR UPDATE`,[profile.source_id]);
    const row=(await client.query(`UPDATE professional_memberships SET status='revoked',revoked_by_user_id=$1,revoked_at=now()
      WHERE source_type=$2 AND source_id=$3 AND user_id=$4 AND status='approved' RETURNING user_id`,
      [reviewer.id,type,profile.source_id,userId])).rows[0];
    if(!row) fail(404,"MEMBERSHIP_NOT_FOUND","Active controller not found.");
    await writeAdminAudit(client,{actorUserId:reviewer.id,action:"professional_membership_revoked",targetType:"professional_profile",
      targetId:`${type}:${profile.source_id}`,summary:`Revoked user ${userId} from professional profile`,reason});
    await client.query("COMMIT");return {sourceType:type,sourceId:profile.source_id,userId,status:"revoked"};
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}
