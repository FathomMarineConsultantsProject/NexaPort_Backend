import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import { provisionCeoUsers, CEO_USERS, normalizeProvisioningEmail } from "../src/services/adminUserProvisioningService.js";

function database() {
  let state = { users: [], user_roles: [], client_profiles: [], client_companies: [], client_verification_events: [], experts: [], expert_registration_details: [] };
  let snapshot;
  const db = { released: false, migration: true, get state() { return state; }, async connect() { return db; }, release() { db.released = true; },
    async query(source, args = []) {
      const sql = source.replace(/\s+/g, " ").trim();
      if (sql === "BEGIN") { snapshot = structuredClone(state); return { rows: [] }; }
      if (sql === "ROLLBACK") { state = snapshot; return { rows: [] }; }
      if (sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("to_regclass")) return { rows: [{ membership_table: db.migration ? "user_roles" : null }] };
      if (sql.includes("information_schema.columns")) return { rows: [{ table_name: "users", column_name: "must_change_password" }, { table_name: "client_companies", column_name: "is_admin_provisioned" }] };
      if (sql.startsWith("INSERT INTO user_roles")) {
        if (!state.user_roles.some((r) => r.user_id === args[0] && r.role_id === args[1])) state.user_roles.push({ user_id: args[0], role_id: args[1] });
        return { rows: [] };
      }
      const insert = sql.match(/^INSERT INTO (\w+)\s*\(([^)]+)\)/);
      if (insert) {
        const row = Object.fromEntries(insert[2].split(",").map((key, i) => [key.trim(), args[i]]));
        row.id = state[insert[1]].length + 1;
        state[insert[1]].push(row);
        return { rows: [{ id: row.id }] };
      }
      if (sql.startsWith("UPDATE users SET password_hash")) {
        Object.assign(state.users.find((u) => u.id === args[1]), { password_hash: args[0], must_change_password: true });
        return { rows: [] };
      }
      const select = sql.match(/FROM (\w+) WHERE (?:LOWER\((\w+)\)|(\w+))\s*=\s*\$1/);
      if (select) {
        const [, table, lower, field] = select;
        const rows = state[table].filter((row) => (lower ? String(row[lower]).toLowerCase() : row[field]) === args[0]);
        return { rows: structuredClone(rows) };
      }
      throw new Error(`Unexpected test query: ${sql}`);
    } };
  return db;
}
const passwords = Object.fromEntries(CEO_USERS.map((u) => [u.passwordKey, "Unit-test-password9!"]));

test("isolated jobs accept verified bcrypt cost-10 hashes without plaintext passwords", async () => {
  const passwordHashes = Object.fromEntries(await Promise.all(CEO_USERS.map(async (u) => [u.passwordKey, await bcrypt.hash("Unit-test-password9!", 10)])));
  const db = database();
  await provisionCeoUsers(db, { passwordHashes });
  for (const user of db.state.users) assert.ok(await bcrypt.compare("Unit-test-password9!", user.password_hash));
  const invalid = database();
  await assert.rejects(provisionCeoUsers(invalid, { passwordHashes: { [CEO_USERS[0].passwordKey]: "not-a-hash" } }), { code: "TEMPORARY_PASSWORD_REQUIRED" });
  assert.equal(invalid.state.users.length, 0);
});

test("provisions three users, two Client companies and two Experts under the correct identities", async () => {
  const db = database();
  const output = await provisionCeoUsers(db, { passwords });
  assert.equal(output.length, 3);
  assert.equal(db.state.users.length, 3);
  assert.equal(db.state.client_profiles.length, 2);
  assert.equal(db.state.experts.length, 2);
  assert.equal(db.state.client_companies[0].legal_name, "1Fleet Maritime | Asset Management");
  assert.equal(db.state.client_companies[1].legal_name, "Inmarserv");
  for (const company of db.state.client_companies) {
    assert.equal(company.is_admin_provisioned, true);
    assert.equal(company.company_type, null);
    assert.equal(company.registered_address, null);
    assert.equal(company.registration_number, null);
  }
  for (const profile of db.state.client_profiles) assert.ok(Number.isFinite(Date.parse(profile.verified_at)));
  const pavan = output.find((u) => u.username === "pavan");
  assert.deepEqual(pavan.roles.sort(), [2, 3]);
  assert.equal(db.state.experts.find((e) => e.id === pavan.expert_id).user_id, pavan.user_id);
  assert.equal(db.state.client_profiles.find((p) => p.id === pavan.client_profile_id).user_id, pavan.user_id);
  assert.equal(db.state.expert_registration_details[0].country, "Cyprus");
  assert.equal(db.state.expert_registration_details[1].mobile_number, "+357 9596 0231");
  for (const details of db.state.expert_registration_details) {
    assert.equal(details.rank, "Not provided");
    assert.equal(details.inspection_cost, "Not provided");
  }
  for (const user of db.state.users) {
    assert.equal(bcrypt.getRounds(user.password_hash), 10);
    assert.ok(await bcrypt.compare("Unit-test-password9!", user.password_hash));
    assert.ok(user.must_change_password);
  }
  for (const expert of db.state.experts) { assert.equal(expert.years_experience, null); assert.equal(expert.day_rate_usd, null); }
  assert.doesNotMatch(JSON.stringify(output), /password|\$2b\$|token/i);
});

test("reruns dedupe lowercase email, restore membership and preserve passwords and profile ids", async () => {
  const db = database();
  const first = await provisionCeoUsers(db, { passwords });
  const hashes = db.state.users.map((u) => u.password_hash);
  db.state.users[0].email = "JSONG@1FSHIPS.COM";
  db.state.user_roles = db.state.user_roles.filter((r) => !(r.user_id === first[2].user_id && r.role_id === 2));
  const second = await provisionCeoUsers(db);
  assert.deepEqual(first, second);
  assert.deepEqual(db.state.users.map((u) => u.password_hash), hashes);
  assert.equal(db.state.users.length, 3);
  assert.equal(db.state.experts.length, 2);
  assert.equal(db.state.client_profiles.length, 2);
  assert.equal(db.state.expert_registration_details.length, 2);
  assert.equal(db.state.client_verification_events.length, 2);
  assert.equal(normalizeProvisioningEmail(" JSONG@1FSHIPS.COM "), "jsong@1fships.com");
});

test("password reset is explicit; identity conflicts and missing migration roll back all writes", async () => {
  const db = database();
  await provisionCeoUsers(db, { passwords });
  const old = db.state.users[0].password_hash;
  await provisionCeoUsers(db, { passwords, resetPassword: true });
  assert.notEqual(db.state.users[0].password_hash, old);
  db.state.experts.push({ ...db.state.experts[0], id: 99 });
  const before = structuredClone(db.state);
  await assert.rejects(provisionCeoUsers(db), { code: "DUPLICATE_PROFILE_REQUIRES_REVIEW" });
  assert.deepEqual(db.state, before);
  const missing = database(); missing.migration = false;
  await assert.rejects(provisionCeoUsers(missing, { passwords }), { code: "MULTI_ROLE_MIGRATION_REQUIRED" });
  assert.equal(missing.state.users.length, 0);
  assert.ok(missing.released);
});
