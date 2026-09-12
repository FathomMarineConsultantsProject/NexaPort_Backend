import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../src/config/db.js";
import { activateRole, loadUserRoles } from "../src/services/userRoleService.js";
import { createRequireAuth, allowRoles } from "../src/middlewares/authMiddleware.js";
import { requireApprovedClient } from "../src/middlewares/clientApprovalMiddleware.js";
import { login, getMe, switchRole } from "../src/controllers/authController.js";
import { getMyProfile, updateMyProfile } from "../src/controllers/userController.js";
import { getClientDashboard, getExpertDashboard } from "../src/controllers/dashboardController.js";

const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const base = { id: 17, full_name: "Test Person", username: "test-person", email: "test@example.test", role_id: 3, is_active: true, verification_status: "approved" };

test("membership lookup falls back before migration and includes legacy default after migration", async () => {
  assert.deepEqual(await loadUserRoles({ query: async () => ({ rows: [{ membership_table: null }] }) }, base), [3]);
  const db = { query: async (sql) => ({ rows: sql.includes("to_regclass") ? [{ membership_table: "user_roles" }] : [{ role_id: 2 }, { role_id: 2 }] }) };
  assert.deepEqual(await loadUserRoles(db, base), [2, 3]);
  assert.throws(() => activateRole(base, [2, 3], 1), { status: 403 });
  assert.throws(() => activateRole(base, [2, 3], 4), { status: 403 });
});

test("login, role switching and /me preserve one identity and validate current memberships", async (t) => {
  process.env.JWT_SECRET = "multi-role-unit-test-only";
  process.env.JWT_EXPIRES_IN = "1h";
  const passwordHash = await bcrypt.hash("Unit-test-password9!", 10);
  let memberships = [3];
  t.mock.method(pool, "query", async (sql) => {
    if (sql.includes("to_regclass")) return { rows: [{ membership_table: "user_roles" }] };
    if (sql.includes("FROM public.user_roles")) return { rows: memberships.map((role_id) => ({ role_id })) };
    return { rows: [{ ...base, ...(sql.includes("u.password_hash") ? { password_hash: passwordHash } : {}) }] };
  });
  let res = response();
  await login({ body: { identifier: "TEST@EXAMPLE.TEST", password: "Unit-test-password9!" } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.user.roles, [3]);
  assert.equal(res.body.user.role_id, 3);
  assert.equal(res.body.user.verification_status, "approved");
  assert.equal(res.body.user.password_hash, undefined);
  memberships = [2, 3];
  res = response();
  await login({ body: { identifier: base.email, password: "Unit-test-password9!" } }, res);
  assert.deepEqual(res.body.user.roles, [2, 3]);
  assert.equal(jwt.verify(res.body.token, process.env.JWT_SECRET).id, base.id);
  for (const role of [2, 3]) {
    res = response();
    await switchRole({ user: base, body: { role_id: role } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.user.id, base.id);
    assert.equal(res.body.user.role_id, role);
    assert.equal(jwt.verify(res.body.token, process.env.JWT_SECRET).active_role, role);
    const me = response();
    await getMe({ user: { ...base, role_id: role } }, me);
    assert.equal(me.body.data.role_id, role);
    assert.deepEqual(me.body.data.roles, [2, 3]);
  }
  for (const role of [1, 4]) {
    res = response();
    await switchRole({ user: base, body: { role_id: role } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.token, undefined);
  }
  res = response();
  await switchRole({ user: base, body: { role_id: "2" } }, res);
  assert.equal(res.statusCode, 400);
});

test("Client and Consultant middleware authorize only the active role; forged and revoked roles fail", async (t) => {
  t.mock.method(pool, "query", async () => ({ rows: [{ is_active: true, verification_status: "approved" }] }));
  for (const role of [2, 3]) {
    const req = { headers: { authorization: "Bearer signed-test-token" } };
    const res = response();
    let authenticated = false;
    await createRequireAuth({ verifyToken: () => ({ id: base.id, active_role: role }),
      queryUser: async () => ({ rows: [{ ...base, roles: [2, 3] }] }) })(req, res, () => { authenticated = true; });
    assert.ok(authenticated);
    assert.equal(req.user.id, base.id);
    let allowed = false;
    allowRoles(role)(req, res, () => { allowed = true; });
    assert.ok(allowed);
    let approved = false;
    await requireApprovedClient(req, res, () => { approved = true; });
    assert.ok(approved);
    allowRoles(role === 2 ? 3 : 2)(req, res, () => assert.fail("wrong workspace allowed"));
    assert.equal(res.statusCode, 403);
  }
  for (const role of [1, 2, 4]) {
    const res = response();
    await createRequireAuth({ verifyToken: () => ({ id: base.id, active_role: role, roles: [1, 2, 3, 4] }),
      queryUser: async () => ({ rows: [{ ...base, roles: [3] }] }) })({ headers: { authorization: "Bearer token" } }, res, () => assert.fail("unassigned role allowed"));
    assert.equal(res.statusCode, 403);
  }
});

test("profile reads and edits retain active role and memberships", async (t) => {
  t.mock.method(pool, "query", async (sql) => ({ rows: sql.includes("SELECT verification_status")
    ? [{ verification_status: "approved" }] : [{ ...base }] }));
  for (const role of [2, 3]) {
    const req = { user: { ...base, role_id: role, roles: [2, 3] }, body: { full_name: "Test Person" } };
    for (const controller of [getMyProfile, updateMyProfile]) {
      const res = response();
      await controller(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.role_id, role);
      assert.deepEqual(res.body.data.roles, [2, 3]);
    }
  }
});

test("both dashboard controllers accept the same user id in their active workspace", async (t) => {
  const queries = [];
  t.mock.method(pool, "query", async (sql, args) => { queries.push(args); return { rows: [] }; });
  for (const [role, controller] of [[2, getExpertDashboard], [3, getClientDashboard]]) {
    const req = { user: activateRole(base, [2, 3], role) };
    const res = response();
    let permitted = false;
    allowRoles(role)(req, res, () => { permitted = true; });
    assert.ok(permitted);
    await controller(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
  }
  assert.ok(queries.length > 1);
  assert.ok(queries.every((args) => args[0] === base.id));
});
