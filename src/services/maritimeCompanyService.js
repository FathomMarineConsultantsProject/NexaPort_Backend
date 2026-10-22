import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import { MARITIME_DIRECTORY_TABLES } from "../config/maritimeDirectorySchema.js";
import {
  getMaritimeEntity,
  replaceTypes,
  uniqueSlug,
  updateMaritimeEntity,
  validateMaritimePayload,
  writeCollections,
} from "./maritimeDirectoryService.js";
import { createPresignedPutUrl } from "../utils/s3Presign.js";
import { companyAccess } from "./companyClaimService.js";

const T = MARITIME_DIRECTORY_TABLES;
const COMPANY_TYPES = new Set(["service_provider", "ship_agent", "supplier"]);
const EMAIL = /^\S+@\S+\.\S+$/;
const LOGO_TYPES = Object.freeze({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" });
const clean = (value) => String(value ?? "").trim();
const invalid = (fieldErrors) => Object.assign(new Error("Please correct the highlighted fields."), {
  status: 400,
  code: "MARITIME_COMPANY_VALIDATION_FAILED",
  fieldErrors,
});

const validateAccount = (account = {}) => {
  const errors = {};
  const fullName = clean(account.fullName);
  const email = clean(account.email).toLowerCase();
  const username = clean(account.username);
  const password = account.password;
  if (!fullName) errors["account.fullName"] = "Contact name is required.";
  if (!EMAIL.test(email)) errors["account.email"] = "Enter a valid email address.";
  if (!username) errors["account.username"] = "Username is required.";
  if (typeof password !== "string" || password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    errors["account.password"] = "Use at least 8 characters with letters and numbers.";
  }
  if (account.confirmPassword !== password) errors["account.confirmPassword"] = "Passwords do not match.";
  if (Object.keys(errors).length) throw invalid(errors);
  return { fullName, email, username, password, phone: clean(account.phone) || null };
};

const validateCompanyTypes = (types) => {
  if (!Array.isArray(types) || types.length === 0) {
    throw invalid({ directoryTypes: "Select at least one company type." });
  }
  const unique = [...new Set(types.map(clean).filter(Boolean))];
  if (unique.length > 3) {
    throw invalid({ directoryTypes: "Select at most three company types." });
  }
  for (const type of unique) {
    if (!COMPANY_TYPES.has(type)) {
      throw invalid({ directoryTypes: `Invalid company type: ${type}` });
    }
  }
  return unique;
};

export const registerMaritimeCompany = async (payload, database = pool) => {
  const account = validateAccount(payload?.account);
  const existingEntityId = payload?.existingEntityId;
  const normalized = existingEntityId ? null : validateMaritimePayload(payload);
  const directoryTypes = existingEntityId ? null : validateCompanyTypes(normalized.directoryTypes);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    if (!existingEntityId) await client.query("SELECT pg_advisory_xact_lock(hashtext(lower(btrim($1))))", [normalized.company.company_name]);
    const duplicate = await client.query("SELECT 1 FROM users WHERE LOWER(email)=$1 OR username=$2", [account.email, account.username]);
    if (duplicate.rows.length) throw Object.assign(new Error("Email or username already exists."), { status: 409, code: "MARITIME_COMPANY_ACCOUNT_EXISTS" });

    if (existingEntityId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(existingEntityId))) throw Object.assign(new Error("Choose a valid existing company."), { status: 400, code: "INVALID_COMPANY" });
      const selected = await client.query("SELECT id FROM maritime_directory_entities WHERE id=$1 AND is_active=true AND review_status='approved'", [existingEntityId]);
      if (!selected.rows.length) throw Object.assign(new Error("Selected company is unavailable."), { status: 404, code: "COMPANY_NOT_FOUND" });
    } else {
      const name = normalized.company.company_name;
      const candidates = await client.query(`SELECT id,public_id,company_name,city,country,review_status,
        lower(btrim(company_name))=lower(btrim($1)) AS exact_match FROM maritime_directory_entities
        WHERE is_active=true AND (lower(btrim(company_name))=lower(btrim($1)) OR similarity(company_name,$1) >= 0.55)
        ORDER BY exact_match DESC,similarity(company_name,$1) DESC,company_name LIMIT 5`, [name]);
      const hiddenExact = candidates.rows.some(row => row.exact_match && row.review_status !== "approved");
      const publicCandidates = candidates.rows.filter(row => row.review_status === "approved").map(({ review_status, ...row }) => row);
      if (hiddenExact || candidates.rows.some(row => row.exact_match) || (candidates.rows.length && payload?.confirmDistinctCompany !== true))
        throw Object.assign(new Error(hiddenExact ? "A company with this name is already being reviewed. Contact NexaPort support before creating another record." : "Possible existing companies found. Select your company or confirm that you represent a different company for Super Admin review."), { status: 409, code: "COMPANY_CANDIDATES", candidates: publicCandidates });
    }

    const passwordHash = await bcrypt.hash(account.password, 10);
    const userResult = await client.query(
      `INSERT INTO users (full_name,email,username,password_hash,role_id,phone,is_active)
       VALUES ($1,$2,$3,$4,4,$5,true)
       RETURNING id,full_name,email,username,role_id,phone,is_active,created_at`,
      [account.fullName, account.email, account.username, passwordHash, account.phone]
    );
    const user = userResult.rows[0];
    if (existingEntityId) {
      await client.query(`INSERT INTO maritime_company_claim_account_intents(user_id,entity_id)
        VALUES($1,$2)`, [user.id,existingEntityId]);
      await client.query("COMMIT");
      return { user: { ...user, account_type: "maritime_company", verification_status: "pending" }, entityId: existingEntityId, claimTarget: existingEntityId };
    }
    const columns = Object.keys(normalized.company);
    const values = Object.values(normalized.company);
    const slug = await uniqueSlug(client, normalized.company.company_name);
    const entityResult = await client.query(
      `INSERT INTO ${T.entities} (${columns.join(",")},slug,data_source,review_status,is_active,created_by_user_id,updated_by_user_id)
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")},$${values.length + 1},'self_registered','pending',true,$${values.length + 2},$${values.length + 2}) RETURNING id`,
      [...values, slug, user.id]
    );
    const entityId = entityResult.rows[0].id;
    await replaceTypes(client, entityId, directoryTypes);
    await writeCollections(client, entityId, payload);
    await client.query(
      `INSERT INTO public.maritime_company_accounts (user_id,entity_id,primary_type) VALUES ($1,$2,$3)`,
      [user.id, entityId, directoryTypes[0]]
    );
    await client.query(`INSERT INTO public.maritime_company_memberships(entity_id,user_id,membership_role,status,verification_origin)
      VALUES($1,$2,'owner','approved','legacy_association')`, [entityId,user.id]);
    await client.query("COMMIT");
    return { user: { ...user, account_type: "maritime_company", verification_status: "pending" }, entityId };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") throw Object.assign(new Error("Email or username already exists."), { status: 409, code: "MARITIME_COMPANY_ACCOUNT_EXISTS" });
    throw error;
  } finally {
    client.release();
  }
};

export const getMaritimeCompanyAccount = async (userId, queryable = pool) => {
  const result = await queryable.query(
    `SELECT m.entity_id,(SELECT directory_type FROM maritime_directory_entity_types WHERE entity_id=m.entity_id ORDER BY directory_type LIMIT 1) AS primary_type,e.review_status,e.is_active
     FROM public.maritime_company_memberships m JOIN ${T.entities} e ON e.id=m.entity_id
     WHERE m.user_id=$1 AND m.status='approved' ORDER BY m.approved_at,m.entity_id LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
};

export const getOwnedMaritimeCompany = async (userId, entityId = null) => {
  const account = entityId ? { entity_id: entityId } : await getMaritimeCompanyAccount(userId);
  if (!account || !(await companyAccess(userId, account.entity_id))) throw Object.assign(new Error("Company profile not found."), { status: 404 });
  const detail = await getMaritimeEntity(account.entity_id);
  const sources = await pool.query("SELECT EXISTS(SELECT 1 FROM directory_entity_sources WHERE entity_id=$1) AS has_imported_sources", [account.entity_id]);
  return { ...detail, account: { ...account, imported_protected: detail.entity.data_source !== "self_registered" || sources.rows[0]?.has_imported_sources } };
};

export const updateOwnedMaritimeCompany = async (userId, payload, entityId = null) => {
  const account = entityId ? { entity_id: entityId } : await getMaritimeCompanyAccount(userId);
  if (!account || !(await companyAccess(userId, account.entity_id))) throw Object.assign(new Error("Company profile not found."), { status: 404 });
  const source = await pool.query(`SELECT e.data_source,EXISTS(SELECT 1 FROM directory_entity_sources s WHERE s.entity_id=e.id) AS has_imported_sources FROM ${T.entities} e WHERE e.id=$1`, [account.entity_id]);
  if (source.rows[0]?.data_source !== "self_registered" || source.rows[0]?.has_imported_sources) {
    const allowed = new Set(["description", "website", "publicEmail", "publicPhone", "publicAddress"]);
    const forbiddenCompany = Object.keys(payload?.company || {}).filter(key => !allowed.has(key));
    const forbiddenSections = ["directoryTypes","services","ports","branches","products","certifications","classApprovals","memberships","faqs"]
      .filter(key => payload?.[key] !== undefined);
    if (forbiddenCompany.length || forbiddenSections.length) throw Object.assign(new Error("Imported company classifications and source records require Super Admin review."), { status: 403, code: "IMPORTED_DATA_PROTECTED" });
  }
  let directoryTypes;
  if (payload?.directoryTypes !== undefined) {
    directoryTypes = validateCompanyTypes(payload.directoryTypes);
  }
  const company = { ...(payload?.company || {}) };
  delete company.logoUrl;
  return updateMaritimeEntity(account.entity_id, { ...payload, company, ...(directoryTypes ? { directoryTypes } : {}) }, userId, { provider: true });
};

const validateLogo = ({ contentType, size }) => {
  if (!LOGO_TYPES[contentType]) throw invalid({ logo: "Use a JPEG, PNG, or WebP image." });
  if (!Number.isInteger(Number(size)) || Number(size) < 1 || Number(size) > 5 * 1024 * 1024) throw invalid({ logo: "Logo must be 5 MB or smaller." });
};

export const createCompanyLogoUpload = async (userId, input, entityId = null) => {
  validateLogo(input);
  const account = entityId ? { entity_id: entityId } : await getMaritimeCompanyAccount(userId);
  if (!account || !(await companyAccess(userId, account.entity_id))) throw Object.assign(new Error("Company profile not found."), { status: 404 });
  const source = await pool.query(`SELECT e.data_source,EXISTS(SELECT 1 FROM directory_entity_sources s WHERE s.entity_id=e.id) AS has_imported_sources FROM ${T.entities} e WHERE e.id=$1`, [account.entity_id]);
  if (source.rows[0]?.data_source !== "self_registered" || source.rows[0]?.has_imported_sources) throw Object.assign(new Error("Imported company logo changes require review."), { status: 403 });
  const key = `company-logos/${userId}/${account.entity_id}/${randomUUID()}.${LOGO_TYPES[input.contentType]}`;
  return { key, uploadUrl: createPresignedPutUrl({ key, contentType: input.contentType, expiresIn: 300 }) };
};

export const confirmCompanyLogoUpload = async (userId, input, entityId = null) => {
  validateLogo(input);
  const account = entityId ? { entity_id: entityId } : await getMaritimeCompanyAccount(userId);
  const expected = `company-logos/${userId}/${account?.entity_id}/`;
  if (!account || !(await companyAccess(userId, account.entity_id)) || typeof input.key !== "string" || !input.key.startsWith(expected) || !input.key.endsWith(`.${LOGO_TYPES[input.contentType]}`)) {
    throw invalid({ logo: "Invalid company logo upload key." });
  }
  const source = await pool.query(`SELECT e.data_source,EXISTS(SELECT 1 FROM directory_entity_sources s WHERE s.entity_id=e.id) AS has_imported_sources FROM ${T.entities} e WHERE e.id=$1`, [account.entity_id]);
  if (source.rows[0]?.data_source !== "self_registered" || source.rows[0]?.has_imported_sources) throw Object.assign(new Error("Imported company logo changes require review."), { status: 403 });
  await pool.query(`UPDATE ${T.entities} SET logo_s3_key=$1,logo_url=NULL,updated_by_user_id=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$3`, [input.key, userId, account.entity_id]);
  return getOwnedMaritimeCompany(userId, account.entity_id);
};
