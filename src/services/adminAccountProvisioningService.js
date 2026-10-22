import bcrypt from "bcrypt";
import { createHash } from "node:crypto";
import { pool } from "../config/db.js";
import { loadUserRoles } from "./userRoleService.js";
import { writeAdminAudit } from "./adminAuditService.js";
import { uniqueSlug, replaceTypes } from "./maritimeDirectoryService.js";

// These are the roles enforced by the existing authenticated application routes.
const ROLE_NAMES = { 1: "Super Admin", 2: "Consultant", 3: "Client", 4: "Maritime Company" };
const ROLE_ALIASES = { super_admin: 1, "super admin": 1, consultant: 2, expert: 2, client: 3, maritime_company: 4, "maritime company": 4, provider: 4 };
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const text = (value) => typeof value === "string" ? value.trim() : "";

export const validateProvisionedAccount = (body = {}) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "INVALID_ACCOUNT_REQUEST", "An account request object is required.");
  const email = text(body.email).toLowerCase();
  const roleId = body.role_id ?? ROLE_ALIASES[text(body.role).toLowerCase()];
  if (!Number.isInteger(roleId) || !ROLE_NAMES[roleId]) fail(400, "INVALID_ACCOUNT_ROLE", "Choose Super Admin, Consultant, Client or Maritime Company.");
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "INVALID_ACCOUNT_EMAIL", "A valid email is required.");
  const password = body.password;
  if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password, "utf8") > 72 || !/[A-Za-z]/.test(password) || !/\d/.test(password))
    fail(400, "INVALID_ACCOUNT_PASSWORD", "Use 12 or more characters including letters and numbers, within 72 UTF-8 bytes.");
  const fullName = text(body.full_name) || email;
  const username = text(body.username) || `user_${createHash("sha256").update(email).digest("hex").slice(0, 20)}`;
  if (fullName.length > 160 || username.length > 80 || !/^[A-Za-z0-9_.@+-]+$/.test(username)) fail(400, "INVALID_ACCOUNT_IDENTITY", "Check the name and username; usernames cannot contain spaces.");
  const companyType = text(body.company_type) || "service_provider";
  if (roleId === 4 && !["service_provider", "ship_agent", "supplier"].includes(companyType)) fail(400, "INVALID_COMPANY_TYPE", "Choose service_provider, ship_agent or supplier.");
  const companyName = text(body.company_name) || email;
  if (companyName.length > 200) fail(400, "INVALID_COMPANY_NAME", "Company display name must be at most 200 characters.");
  return { email, roleId, password, fullName, username, companyType, companyName };
};

const profileForRole = async (db, user, roleId) => {
  if (roleId === 1) return { profileId: null, profileSetupRequired: false };
  const sql = roleId === 3 ? "SELECT id,verification_status FROM client_profiles WHERE user_id=$1"
    : roleId === 2 ? "SELECT e.id FROM experts e JOIN expert_registration_details d ON d.expert_id=e.id AND d.user_id=e.user_id WHERE e.user_id=$1"
      : "SELECT entity_id AS id FROM maritime_company_accounts WHERE user_id=$1";
  const rows = (await db.query(sql, [user.id])).rows;
  if (rows.length !== 1 || roleId === 3 && rows[0].verification_status !== "approved")
    fail(409, "EXISTING_ACCOUNT_PROFILE_INCOMPLETE", "The existing account needs review through its current profile/approval workflow; it was not modified.");
  return { profileId: rows[0].id, profileSetupRequired: roleId !== 3 };
};

export const provisionAdminAccount = async ({ actor, body, database = pool }) => {
  if (Number(actor?.role_id) !== 1 || !Number.isSafeInteger(Number(actor?.id)) || Number(actor.id) <= 0)
    fail(403, "ADMIN_ACCOUNT_PROVISIONING_FORBIDDEN", "Super Admin access is required.");
  const input = validateProvisionedAccount(body);
  const db = await database.connect();
  try {
    await db.query("BEGIN");
    // Stable lock order protects duplicate requests and shared usernames.
    for (const key of [`email:${input.email}`, `username:${input.username.toLowerCase()}`].sort())
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`admin-account:${key}`]);
    const schema = (await db.query("SELECT to_regclass('public.user_roles') AS memberships,to_regclass('public.roles') AS roles")).rows[0];
    if (!schema?.memberships) fail(503, "ACCOUNT_MEMBERSHIP_SCHEMA_REQUIRED", "The existing multi-role schema is required; no account was created.");
    const columns = (await db.query(`SELECT table_name,column_name,is_nullable,column_default,is_identity
      FROM information_schema.columns WHERE table_schema='public' AND table_name IN
      ('users','roles','client_profiles','experts','expert_registration_details','maritime_directory_entities')`)).rows;
    if (schema.roles) {
      const nameColumn = ["role_name", "name"].find(name => columns.some(c => c.table_name === "roles" && c.column_name === name));
      if (!nameColumn) fail(503, "ACCOUNT_ROLE_CONFIGURATION_UNSUPPORTED", "The live role configuration must be reviewed.");
      const role = (await db.query(`SELECT ${nameColumn} AS name FROM roles WHERE id=$1`, [input.roleId])).rows[0];
      const aliases = { 1: ["super admin", "super_admin", "superadmin", "admin"], 2: ["consultant", "expert", "surveyor", "consultant / expert"], 3: ["client"], 4: ["maritime company", "maritime_company", "provider"] };
      if (!role || !aliases[input.roleId].includes(String(role.name).trim().toLowerCase())) fail(503, "ACCOUNT_ROLE_CONFIGURATION_MISMATCH", "Live role definitions disagree with the application's authorization rules.");
    }
    const existing = (await db.query("SELECT id,full_name,email,username,role_id,is_active,password_hash FROM users WHERE LOWER(email)=$1 OR LOWER(username)=$2 FOR UPDATE", [input.email, input.username.toLowerCase()])).rows;
    if (existing.length) {
      const user = existing.length === 1 && existing[0];
      if (!user || String(user.email).toLowerCase() !== input.email || String(user.username).toLowerCase() !== input.username.toLowerCase())
        fail(409, "ACCOUNT_IDENTITY_CONFLICT", "Email or username is already in use; existing accounts were not modified.");
      const roles = await loadUserRoles(db, user);
      if (!user.is_active || !roles.includes(input.roleId) || !await bcrypt.compare(input.password, user.password_hash))
        fail(409, "ACCOUNT_ALREADY_EXISTS", "This account already exists with different credentials, status or roles. No password or role was changed.");
      const profile = await profileForRole(db, user, input.roleId);
      await db.query("COMMIT");
      return { created: false, user: { id: user.id, full_name: user.full_name, email: user.email, username: user.username, role_id: input.roleId, roles, is_active: true }, ...profile };
    }
    const insert = async (table, values) => {
      // Identifiers originate only from the fixed internal objects below.
      const missing = columns.filter(c => c.table_name === table && c.is_nullable === "NO" && c.column_default == null && c.is_identity !== "YES" && !(c.column_name in values));
      if (missing.length) fail(503, "ACCOUNT_PROFILE_SCHEMA_REQUIRES_DATA", `Required ${table} fields are unavailable: ${missing.map(c => c.column_name).join(", ")}. No account was created.`);
      const fields = Object.keys(values);
      return (await db.query(`INSERT INTO ${table} (${fields.join(",")}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`, Object.values(values))).rows[0].id;
    };
    const userId = await insert("users", { full_name: input.fullName, email: input.email, username: input.username,
      password_hash: await bcrypt.hash(input.password, 10), role_id: input.roleId, phone: null, is_active: true });
    await db.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,$2) ON CONFLICT(user_id,role_id) DO NOTHING", [userId, input.roleId]);
    let profileId = null;
    if (input.roleId === 3) {
      profileId = await insert("client_profiles", { user_id: userId, verification_status: "approved", verified_at: new Date().toISOString(), verified_by_user_id: Number(actor.id),
        verification_notes: "Account access approved by Super Admin provisioning. Company and email ownership verification are not asserted." });
      await db.query(`INSERT INTO client_verification_events(client_profile_id,previous_status,new_status,actor_user_id,internal_note)
        VALUES($1,NULL,'approved',$2,'Super Admin authorized account provisioning; no documentary or email verification claimed.')`, [profileId, actor.id]);
    } else if (input.roleId === 2) {
      profileId = await insert("experts", { user_id: userId, full_name: input.fullName, biography: "Admin-provisioned Consultant account. Professional profile details have not been supplied.",
        country: null, base_location: null, years_experience: null, day_rate_usd: null, availability: null });
      const [firstName, ...lastName] = input.fullName.split(/\s+/);
      // Retain the existing administrative provisioning convention for mandatory
      // legacy text fields. No professional qualification or contact is invented.
      await insert("expert_registration_details", { user_id: userId, expert_id: profileId, first_name: firstName, last_name: lastName.join(" ") || "Not provided", email: input.email,
        country: "Not provided", company_name: null, phone_number: "Not provided", mobile_number: null,
        nationality: "Not provided", employment_status: "Not provided", dob_dd: "Not provided", dob_mm: "Not provided", dob_yyyy: "Not provided", heard_about: "Admin provisioned",
        street1: "Not provided", city: "Not provided", postal_code: "Not provided", state_region: "Not provided", discipline: "Not provided", rank: "Not provided", inspection_cost: "Not provided" });
    } else if (input.roleId === 4) {
      const slug = await uniqueSlug(db, input.companyName);
      profileId = await insert("maritime_directory_entities", { company_name: input.companyName, slug, data_source: "self_registered", review_status: "pending", is_active: true, created_by_user_id: userId, updated_by_user_id: userId });
      await replaceTypes(db, profileId, [input.companyType]);
      await db.query("INSERT INTO maritime_company_accounts(user_id,entity_id,primary_type) VALUES($1,$2,$3)", [userId, profileId, input.companyType]);
      await db.query("INSERT INTO maritime_company_memberships(entity_id,user_id,membership_role,status) VALUES($1,$2,'owner','approved')", [profileId,userId]);
    }
    await writeAdminAudit(db, { actorUserId: actor.id, action: "account.admin_provisioned", targetType: "user", targetId: userId,
      summary: `Created active ${ROLE_NAMES[input.roleId]} account; role/profile linked.`, reason: "Explicit Super Admin provisioning; no email delivery or credential verification claim." });
    const user = { id: userId, full_name: input.fullName, email: input.email, username: input.username, role_id: input.roleId, roles: [input.roleId], is_active: true };
    await profileForRole(db, user, input.roleId);
    await db.query("COMMIT");
    return { created: true, user, profileId, profileSetupRequired: [2, 4].includes(input.roleId), emailVerificationPerformed: false };
  } catch (error) {
    await db.query("ROLLBACK");
    if (error.code === "23505") fail(409, "ACCOUNT_IDENTITY_CONFLICT", "An account or profile already uses this identity; no duplicate was created.");
    throw error;
  } finally { db.release(); }
};
