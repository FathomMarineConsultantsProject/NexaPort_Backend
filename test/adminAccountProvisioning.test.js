import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcrypt";
import { readFile } from "node:fs/promises";
import { provisionAdminAccount, validateProvisionedAccount } from "../src/services/adminAccountProvisioningService.js";
import { createRequireAuth, allowRoles } from "../src/middlewares/authMiddleware.js";
import { createAccountAsAdmin } from "../src/controllers/adminAccountProvisioningController.js";

const actor = { id: 10, role_id: 1 };
const body = { full_name: "Sanjay Joseph", username: "sanjay_joseph_client", email: "sanjay.joseph.client@example.com", password: "Unit-test-credential29!", role_id: 3 };
const fixture = () => {
  let state = { users: [], user_roles: [], client_profiles: [], experts: [], expert_registration_details: [], maritime_directory_entities: [], maritime_company_accounts: [], maritime_directory_entity_types: [], client_verification_events: [], admin_audit_logs: [] };
  let snapshot;
  const calls = [];
  const db = { state: () => state, calls, released: false, missingMemberships: false, roleNames: null, failOn: null, columns: [],
    async connect() { return db; }, release() { db.released = true; }, async query(source, values = []) {
      const sql = source.replace(/\s+/g, " ").trim(); calls.push(sql);
      if (sql === "BEGIN") { snapshot = structuredClone(state); return { rows: [] }; }
      if (sql === "ROLLBACK") { state = snapshot; return { rows: [] }; }
      if (sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (db.failOn && sql.includes(db.failOn)) throw Object.assign(new Error("Simulated write failure"), { code: "23514" });
      if (sql.includes("to_regclass")) return { rows: [{ memberships: db.missingMemberships ? null : "user_roles", membership_table: "user_roles", roles: db.roleNames ? "roles" : null }] };
      if (sql.includes("information_schema.columns")) return { rows: [...db.columns, ...(db.roleNames ? [{ table_name: "roles", column_name: "role_name" }] : [])] };
      if (sql.startsWith("SELECT role_name")) return { rows: db.roleNames[values[0]] ? [{ name: db.roleNames[values[0]] }] : [] };
      if (sql.includes("FROM users WHERE LOWER(email)")) return { rows: state.users.filter(u => u.email.toLowerCase() === values[0] || u.username.toLowerCase() === values[1]).map(u => ({ ...u })) };
      if (sql.includes("SELECT role_id FROM public.user_roles")) return { rows: state.user_roles.filter(r => r.user_id === values[0]) };
      if (sql.startsWith("SELECT e.id FROM experts")) return { rows: state.experts.filter(e => e.user_id === values[0] && state.expert_registration_details.some(d => d.expert_id === e.id && d.user_id === e.user_id)) };
      if (sql.includes("FROM client_profiles WHERE")) return { rows: state.client_profiles.filter(p => p.user_id === values[0]) };
      if (sql.includes("FROM maritime_company_accounts WHERE")) return { rows: state.maritime_company_accounts.filter(p => p.user_id === values[0]).map(p => ({ id: p.entity_id })) };
      if (sql.startsWith("SELECT 1 FROM public.maritime_directory_entities")) return { rows: [] };
      if (sql.startsWith("DELETE FROM public.maritime_directory_entity_types")) return { rows: [] };
      const insert = sql.match(/^INSERT INTO (?:public\.)?(\w+)\s*\(([^)]+)\)/);
      if (insert) {
        const row = Object.fromEntries(insert[2].split(",").map((key, i) => [key.trim(), values[i]]));
        if (insert[1] === "client_verification_events") Object.assign(row, { previous_status: null, new_status: "approved", actor_user_id: values[1] });
        row.id = state[insert[1]].length + 1; state[insert[1]].push(row); return { rows: [{ id: row.id }] };
      }
      throw new Error(`Unexpected fixture query: ${sql}`);
    } };
  return db;
};
const run = (db, overrides = {}, role = actor) => provisionAdminAccount({ actor: role, body: { ...body, ...overrides }, database: db });

test("email, password and role are sufficient; unknown fields are not invented", () => {
  const parsed = validateProvisionedAccount({ email: " Person@Example.com ", password: body.password, role: "consultant" });
  assert.equal(parsed.email, "person@example.com"); assert.equal(parsed.roleId, 2); assert.equal(parsed.fullName, parsed.email);
  assert.match(parsed.username, /^user_[a-f0-9]{20}$/);
  assert.equal(parsed.username, validateProvisionedAccount({ email: "person@example.com", password: body.password, role_id: 2 }).username);
});

test("invalid identities, roles and bcrypt-truncated passwords fail before connection", async () => {
  for (const overrides of [{ email: "invalid" }, { password: "weak" }, { password: "long" + "a".repeat(70) + "9" }, { password: "a9" + "\u20ac".repeat(24) }, { role_id: 99 }, { role_id: "3" }, { username: "space name" }]) {
    const db = fixture(); await assert.rejects(run(db, overrides), error => error.status === 400); assert.equal(db.calls.length, 0);
  }
});

test("unauthenticated actors and every non-Admin role fail before database access", async () => {
  for (const role of [null, { id: 1, role_id: 2 }, { id: 1, role_id: 3 }, { id: 1, role_id: 4 }]) {
    const db = fixture(); await assert.rejects(run(db, {}, role), { code: "ADMIN_ACCOUNT_PROVISIONING_FORBIDDEN" }); assert.equal(db.calls.length, 0);
  }
});

test("Client receives active membership, linked approved profile, real Admin approval event and no invented company", async () => {
  const db = fixture(), result = await run(db), state = db.state();
  assert.equal(result.user.role_id, 3); assert.equal(result.user.is_active, true); assert.deepEqual(result.user.roles, [3]);
  assert.equal(state.client_profiles[0].user_id, result.user.id); assert.equal(state.client_profiles[0].verification_status, "approved"); assert.equal(state.client_profiles[0].verified_by_user_id, actor.id);
  assert.equal(state.client_verification_events[0].actor_user_id, actor.id); assert.equal(state.admin_audit_logs[0].actor_user_id, actor.id);
  assert.ok(await bcrypt.compare(body.password, state.users[0].password_hash)); assert.equal(bcrypt.getRounds(state.users[0].password_hash), 10);
  assert.equal(result.emailVerificationPerformed, false); assert.doesNotMatch(JSON.stringify(result), /password|\$2b\$|token/);
  assert.equal(db.calls.at(-1), "COMMIT"); assert.ok(db.released);
});

test("Consultant receives both linked Expert records without invented qualifications or prices", async () => {
  const db = fixture(); const result = await run(db, { role_id: 2, username: "sanjay_joseph_consultant", email: "sanjay.joseph.consultant@example.com" });
  assert.equal(result.user.role_id, 2); assert.equal(result.profileSetupRequired, true);
  const expert = db.state().experts[0], details = db.state().expert_registration_details[0];
  assert.equal(expert.user_id, result.user.id); assert.equal(details.expert_id, expert.id); assert.equal(details.user_id, result.user.id);
  assert.equal(expert.day_rate_usd, null); assert.equal(expert.years_experience, null); assert.equal(details.discipline, "Not provided"); assert.equal(details.phone_number, "Not provided");
});

test("Super Admin and Maritime Company roles use their existing profile conventions", async () => {
  const adminDb = fixture(), admin = await run(adminDb, { role_id: 1 }); assert.equal(admin.user.role_id, 1); assert.equal(admin.profileId, null);
  const companyDb = fixture(), company = await run(companyDb, { role_id: 4, company_name: "Display name", company_type: "supplier" });
  assert.equal(company.user.role_id, 4); assert.equal(companyDb.state().maritime_company_accounts[0].primary_type, "supplier");
  assert.equal(companyDb.state().maritime_directory_entity_types[0].directory_type, "supplier");
  assert.equal(companyDb.state().maritime_directory_entities[0].review_status, "pending");
});

test("matching retries are idempotent and preserve hashes, roles, profiles and audit history", async () => {
  const db = fixture(); const first = await run(db), before = structuredClone(db.state()); const second = await run(db);
  assert.equal(second.created, false); assert.equal(second.user.id, first.user.id); assert.deepEqual(db.state(), before);
});

test("existing users are never reset, activated, reassigned or repaired implicitly", async () => {
  for (const scenario of [
    { mutate() {}, overrides: { password: "Different-test-secret98!" } },
    { mutate(db) { db.state().users[0].is_active = false; }, overrides: {} },
    { mutate(db) { db.state().client_profiles[0].verification_status = "pending"; }, overrides: {} },
  ]) {
    const db = fixture(); await run(db); scenario.mutate(db); const before = structuredClone(db.state());
    await assert.rejects(run(db, scenario.overrides), error => error.status === 409);
    assert.deepEqual(db.state(), before);
  }
  const db = fixture(); await run(db); const before = structuredClone(db.state());
  await assert.rejects(run(db, { role_id: 2 }), { code: "ACCOUNT_ALREADY_EXISTS" }); assert.deepEqual(db.state(), before);
});

test("colliding usernames and missing membership or mismatched live role configuration fail closed", async () => {
  const db = fixture(); await run(db); await assert.rejects(run(db, { email: "another@example.com" }), { code: "ACCOUNT_IDENTITY_CONFLICT" }); assert.equal(db.state().users.length, 1);
  const missing = fixture(); missing.missingMemberships = true; await assert.rejects(run(missing), { code: "ACCOUNT_MEMBERSHIP_SCHEMA_REQUIRED" }); assert.equal(missing.state().users.length, 0);
  const roles = fixture(); roles.roleNames = { 3: "Super Admin" }; await assert.rejects(run(roles), { code: "ACCOUNT_ROLE_CONFIGURATION_MISMATCH" }); assert.equal(roles.state().users.length, 0);
  roles.roleNames = { 3: "Client" }; assert.equal((await run(roles)).created, true);
});

test("profile/schema/audit failures roll back every user, membership and profile write", async () => {
  for (const failOn of ["INSERT INTO expert_registration_details", "INSERT INTO public.admin_audit_logs"]) {
    const db = fixture(); db.failOn = failOn; await assert.rejects(run(db, { role_id: 2 })); assert.equal(db.state().users.length, 0); assert.equal(db.state().experts.length, 0); assert.equal(db.calls.at(-1), "ROLLBACK");
  }
  const db = fixture(); db.columns = [{ table_name: "client_profiles", column_name: "unknown_required_field", is_nullable: "NO", column_default: null }];
  await assert.rejects(run(db), { code: "ACCOUNT_PROFILE_SCHEMA_REQUIRES_DATA" }); assert.equal(db.state().users.length, 0);
});

test("route remains behind authentication and Super Admin guard; controller also rejects non-Admins", async () => {
  const source = await readFile(new URL("../src/routes/adminAdministrationRoutes.js", import.meta.url), "utf8");
  assert.ok(source.indexOf("router.use(requireAuth, allowRoles(1))") < source.indexOf('router.post("/accounts", createAccountAsAdmin)'));
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await createRequireAuth()({ headers: {} }, res, () => assert.fail("Anonymous access allowed")); assert.equal(res.statusCode, 401);
  for (const role_id of [2, 3, 4]) { allowRoles(1)({ user: { role_id } }, res, () => assert.fail("Unauthorized role allowed")); assert.equal(res.statusCode, 403); }
  await createAccountAsAdmin({ user: { id: 12, role_id: 3 }, body }, res); assert.equal(res.statusCode, 403); assert.doesNotMatch(JSON.stringify(res.body), /Unit-test-credential|password_hash/);
});
