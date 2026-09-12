import bcrypt from "bcrypt";

export const CEO_USERS = [
  { full_name: "Jagmohan Singh", email: "jsong@1fships.com", username: "jsong", roles: [3], company: "1Fleet Maritime | Asset Management", passwordKey: "JAGMOHAN_TEMP_PASSWORD" },
  { full_name: "Swapneel", email: "neel@inmarserv.com", username: "neel", roles: [2], country: "Cyprus", passwordKey: "SWAPNEEL_TEMP_PASSWORD" },
  { full_name: "Pavan Bidi", email: "pavan@inmarserv.com", username: "pavan", roles: [3, 2], company: "Inmarserv", country: "India / Cyprus", phone: "+91 95662 55503", mobile: "+357 9596 0231", passwordKey: "PAVAN_TEMP_PASSWORD" },
];

export const normalizeProvisioningEmail = (email) => String(email).trim().toLowerCase();
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

// No public registration validation is changed. All three accounts commit atomically.
export async function provisionCeoUsers(pool, { passwords = {}, passwordHashes = {}, resetPassword = false } = {}) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    // Serialize reruns, including across separate processes.
    await db.query("SELECT pg_advisory_xact_lock(728104, 3)");
    const schema = await db.query("SELECT to_regclass('public.user_roles') AS membership_table");
    if (!schema.rows[0]?.membership_table) fail("MULTI_ROLE_MIGRATION_REQUIRED");
    const columns = await db.query(`SELECT table_name,column_name,is_nullable,column_default,data_type
      FROM information_schema.columns WHERE table_schema='public'
      AND table_name IN ('users','client_profiles','client_companies','experts','expert_registration_details')`);
    const userColumns = new Set(columns.rows.filter((c) => c.table_name === "users").map((c) => c.column_name));
    if (!columns.rows.some((c) => c.table_name === "client_companies" && c.column_name === "is_admin_provisioned")) fail("ADMIN_PROVISIONING_MIGRATION_REQUIRED");
    const insert = async (table, values) => {
      const fields = Object.keys(values);
      // Table and field names come only from the fixed objects below, never external input.
      const result = await db.query(`INSERT INTO ${table} (${fields.join(",")}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`, Object.values(values));
      return result.rows[0].id;
    };
    const single = async (table, field, value) => {
      const found = await db.query(`SELECT * FROM ${table} WHERE ${field}=$1 FOR UPDATE`, [value]);
      if (found.rows.length > 1) fail("DUPLICATE_PROFILE_REQUIRES_REVIEW");
      return found.rows[0];
    };
    const output = [];
    for (const spec of CEO_USERS) {
      const email = normalizeProvisioningEmail(spec.email);
      const found = await db.query("SELECT * FROM users WHERE LOWER(email)=$1 FOR UPDATE", [email]);
      if (found.rows.length > 1) fail("DUPLICATE_EMAIL_REQUIRES_REVIEW");
      let user = found.rows[0];
      if (user && !user.is_active) fail("EXISTING_INACTIVE_ACCOUNT_REQUIRES_REVIEW");
      if (user && !spec.roles.includes(Number(user.role_id))) fail("EXISTING_ROLE_CONFLICT_REQUIRES_REVIEW");
      const password = passwords[spec.passwordKey];
      const needsPassword = !user || resetPassword;
      const suppliedHash = passwordHashes[spec.passwordKey];
      const hasPassword = typeof password === "string" && password.length >= 8;
      // An isolated administrative job may receive locally generated bcrypt hashes
      // instead of uploading plaintext passwords. This service is never a public route.
      const hasHash = typeof suppliedHash === "string" && /^\$2b\$10\$[./A-Za-z0-9]{53}$/.test(suppliedHash);
      if (needsPassword && !hasPassword && !hasHash) fail("TEMPORARY_PASSWORD_REQUIRED");
      const passwordHash = needsPassword ? (hasPassword ? await bcrypt.hash(password, 10) : suppliedHash) : null;
      const resetFlags = Object.fromEntries(["must_change_password", "password_reset_required"].filter((key) => userColumns.has(key)).map((key) => [key, true]));
      if (!user) {
        const username = await db.query("SELECT id FROM users WHERE LOWER(username)=$1", [spec.username]);
        if (username.rows.length) fail("USERNAME_CONFLICT_REQUIRES_REVIEW");
        const id = await insert("users", { full_name: spec.full_name, email, username: spec.username, password_hash: passwordHash,
          role_id: spec.roles[0], phone: spec.phone || null, is_active: true, ...resetFlags });
        user = { id, username: spec.username, role_id: spec.roles[0] };
      } else if (resetPassword) {
        await db.query(`UPDATE users SET password_hash=$1${Object.keys(resetFlags).map((key) => `,${key}=true`).join("")} WHERE id=$2`, [passwordHash, user.id]);
      }
      for (const role of spec.roles) await db.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,$2) ON CONFLICT(user_id,role_id) DO NOTHING", [user.id, role]);

      let clientProfileId = null, companyId = null, expertId = null;
      if (spec.roles.includes(3)) {
        let profile = await single("client_profiles", "user_id", user.id);
        if (!profile) {
          clientProfileId = await insert("client_profiles", { user_id: user.id, verification_status: "approved", verified_at: new Date().toISOString() });
          await db.query(`INSERT INTO client_verification_events(client_profile_id,previous_status,new_status,internal_note)
            VALUES($1,NULL,'approved','Admin-provisioned business account')`, [clientProfileId]);
        } else {
          clientProfileId = profile.id;
          if (profile.verification_status !== "approved") {
            await db.query("UPDATE client_profiles SET verification_status='approved',verified_at=CURRENT_TIMESTAMP WHERE id=$1", [profile.id]);
            await db.query(`INSERT INTO client_verification_events(client_profile_id,previous_status,new_status,internal_note)
              VALUES($1,$2,'approved','Admin-provisioned business account')`, [profile.id, profile.verification_status]);
          }
        }
        const company = await single("client_companies", "client_profile_id", clientProfileId);
        if (company && company.legal_name !== spec.company) fail("EXISTING_COMPANY_CONFLICT_REQUIRES_REVIEW");
        companyId = company?.id || await insert("client_companies", { client_profile_id: clientProfileId, legal_name: spec.company,
          is_admin_provisioned: true, company_type: null, registered_address: null, registration_number: null,
          country: spec.country || null, authorized_representative_name: spec.full_name,
          authorized_representative_email: email, authorized_representative_phone: spec.phone || null });
      }
      if (spec.roles.includes(2)) {
        const expert = await single("experts", "user_id", user.id);
        expertId = expert?.id || await insert("experts", { user_id: user.id, full_name: spec.full_name,
          biography: "Admin-provisioned Consultant account.", country: spec.country, base_location: spec.country,
          years_experience: null, day_rate_usd: null, availability: null });
        const details = await single("expert_registration_details", "expert_id", expertId);
        if (details && Number(details.user_id) !== Number(user.id)) fail("EXPERT_IDENTITY_CONFLICT_REQUIRES_REVIEW");
        if (!details) {
          const [firstName, ...lastName] = spec.full_name.split(" ");
          await insert("expert_registration_details", { user_id: user.id, expert_id: expertId,
            first_name: firstName, last_name: lastName.join(" ") || "Not provided", email,
            country: spec.country, company_name: spec.company || null,
            phone_number: spec.phone || "Not provided", mobile_number: spec.mobile || null,
            nationality: "Not provided", employment_status: "Not provided",
            dob_dd: "Not provided", dob_mm: "Not provided", dob_yyyy: "Not provided",
            heard_about: "Admin provisioned", street1: "Not provided", city: "Not provided",
            postal_code: "Not provided", state_region: "Not provided", discipline: "Not provided",
            rank: "Not provided", inspection_cost: "Not provided" });
        }
      }
      // Automated verification before commit: identity, memberships, profiles and hashing.
      const verified = await db.query("SELECT id,password_hash FROM users WHERE LOWER(email)=$1", [email]);
      if (verified.rows.length !== 1 || verified.rows[0].id !== user.id) fail("USER_VERIFICATION_FAILED");
      if (needsPassword && (hasPassword
        ? !(await bcrypt.compare(password, verified.rows[0].password_hash))
        : verified.rows[0].password_hash !== passwordHash)) fail("PASSWORD_VERIFICATION_FAILED");
      const roles = (await db.query("SELECT role_id FROM user_roles WHERE user_id=$1 ORDER BY role_id", [user.id])).rows.map((r) => Number(r.role_id));
      if (!spec.roles.every((r) => roles.includes(r))) fail("ROLE_VERIFICATION_FAILED");
      if (expertId && (await single("experts", "user_id", user.id))?.id !== expertId) fail("EXPERT_VERIFICATION_FAILED");
      if (clientProfileId && (await single("client_profiles", "user_id", user.id))?.id !== clientProfileId) fail("CLIENT_VERIFICATION_FAILED");
      output.push({ full_name: spec.full_name, user_id: user.id, username: user.username, email, roles,
        client_profile_id: clientProfileId, company_id: companyId, expert_id: expertId });
    }
    await db.query("COMMIT");
    return output;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }
}
