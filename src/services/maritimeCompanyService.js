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
  const normalized = validateMaritimePayload(payload);
  const directoryTypes = validateCompanyTypes(normalized.directoryTypes);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const duplicate = await client.query("SELECT 1 FROM users WHERE LOWER(email)=$1 OR username=$2", [account.email, account.username]);
    if (duplicate.rows.length) throw Object.assign(new Error("Email or username already exists."), { status: 409, code: "MARITIME_COMPANY_ACCOUNT_EXISTS" });

    const passwordHash = await bcrypt.hash(account.password, 10);
    const userResult = await client.query(
      `INSERT INTO users (full_name,email,username,password_hash,role_id,phone,is_active)
       VALUES ($1,$2,$3,$4,4,$5,true)
       RETURNING id,full_name,email,username,role_id,phone,is_active,created_at`,
      [account.fullName, account.email, account.username, passwordHash, account.phone]
    );
    const user = userResult.rows[0];
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
    `SELECT mca.entity_id,mca.primary_type,e.review_status,e.is_active
     FROM public.maritime_company_accounts mca
     JOIN ${T.entities} e ON e.id=mca.entity_id
     WHERE mca.user_id=$1`,
    [userId]
  );
  return result.rows[0] || null;
};

export const getOwnedMaritimeCompany = async (userId) => {
  const account = await getMaritimeCompanyAccount(userId);
  if (!account) throw Object.assign(new Error("Company profile not found."), { status: 404 });
  return { ...(await getMaritimeEntity(account.entity_id)), account };
};

export const updateOwnedMaritimeCompany = async (userId, payload) => {
  const account = await getMaritimeCompanyAccount(userId);
  if (!account) throw Object.assign(new Error("Company profile not found."), { status: 404 });
  let directoryTypes;
  if (payload?.directoryTypes !== undefined) {
    directoryTypes = validateCompanyTypes(payload.directoryTypes);
  }
  const company = { ...(payload?.company || {}) };
  delete company.logoUrl;
  return updateMaritimeEntity(account.entity_id, { ...payload, company, ...(directoryTypes ? { directoryTypes } : {}) }, userId);
};

const validateLogo = ({ contentType, size }) => {
  if (!LOGO_TYPES[contentType]) throw invalid({ logo: "Use a JPEG, PNG, or WebP image." });
  if (!Number.isInteger(Number(size)) || Number(size) < 1 || Number(size) > 5 * 1024 * 1024) throw invalid({ logo: "Logo must be 5 MB or smaller." });
};

export const createCompanyLogoUpload = async (userId, input) => {
  validateLogo(input);
  const account = await getMaritimeCompanyAccount(userId);
  if (!account) throw Object.assign(new Error("Company profile not found."), { status: 404 });
  const key = `company-logos/${userId}/${randomUUID()}.${LOGO_TYPES[input.contentType]}`;
  return { key, uploadUrl: createPresignedPutUrl({ key, contentType: input.contentType, expiresIn: 300 }) };
};

export const confirmCompanyLogoUpload = async (userId, input) => {
  validateLogo(input);
  const account = await getMaritimeCompanyAccount(userId);
  const expected = `company-logos/${userId}/`;
  if (!account || typeof input.key !== "string" || !input.key.startsWith(expected) || !input.key.endsWith(`.${LOGO_TYPES[input.contentType]}`)) {
    throw invalid({ logo: "Invalid company logo upload key." });
  }
  await pool.query(`UPDATE ${T.entities} SET logo_s3_key=$1,logo_url=NULL,updated_by_user_id=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$3`, [input.key, userId, account.entity_id]);
  return getOwnedMaritimeCompany(userId);
};
