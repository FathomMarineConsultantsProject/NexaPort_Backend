import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/config/db.js";
import { userMayViewRequest } from "../src/services/requestVisibilityService.js";
import { copyRequestLink, resolveRequestLink, revokeRequestLink } from "../src/controllers/requestShareController.js";

const response = () => ({
  statusCode: 200, headers: {}, body: null,
  status(code) { this.statusCode = code; return this; },
  set(name, value) { this.headers[name] = value; return this; },
  json(value) { this.body = value; return this; },
});
const locator = "a".repeat(64);

test("marketplace and assigned Consultant use the same visibility policy", async () => {
  const db = { query: async () => ({ rowCount: 1 }) };
  const user = { id: 8, role_id: 2 };
  assert.equal(await userMayViewRequest(db, { id: 1, status: "open", moderation_status: "approved" }, user), true);
  assert.equal(await userMayViewRequest(db, { id: 1, status: "assigned", moderation_status: "approved" }, user), true);
  assert.equal(await userMayViewRequest(db, { id: 1, status: "pending", moderation_status: "pending" }, user), false);
  assert.equal(await userMayViewRequest({ query: async () => ({ rowCount: 0 }) }, { id: 1, status: "completed", moderation_status: "approved" }, user), false);
});

test("owner, Admin, other Client and Provider access", async () => {
  const request = { id: 4, requester_user_id: 10 };
  const db = { query: async () => { throw new Error("should not query"); } };
  assert.equal(await userMayViewRequest(db, request, { id: 10, role_id: 3 }), true);
  assert.equal(await userMayViewRequest(db, request, { id: 11, role_id: 3 }), false);
  assert.equal(await userMayViewRequest(db, request, { id: 11, role_id: 1 }), true);
  assert.equal(await userMayViewRequest(db, request, { id: 10, role_id: 4 }), false);
});

test("resolver reveals only a request ID after authorization", async () => {
  const original = pool.query;
  pool.query = async () => ({ rows: [{ id: 4, requester_user_id: 10, title: "Private vessel" }] });
  try {
    const owner = response();
    await resolveRequestLink({ body: { locator }, user: { id: 10, role_id: 3 } }, owner);
    assert.deepEqual(owner.body, { success: true, data: { requestId: 4 } });
    assert.equal(JSON.stringify(owner.body).includes("Private vessel"), false);
    const other = response();
    await resolveRequestLink({ body: { locator }, user: { id: 11, role_id: 3 } }, other);
    assert.equal(other.statusCode, 403);
    assert.equal(JSON.stringify(other.body).includes("Private vessel"), false);
    const invalid = response();
    await resolveRequestLink({ body: { locator: "4" }, user: { id: 10, role_id: 3 } }, invalid);
    assert.equal(invalid.statusCode, 404);
  } finally { pool.query = original; }
});

test("expired, revoked and deleted links are unavailable", async () => {
  const original = pool.query;
  pool.query = async () => ({ rows: [] });
  try {
    const res = response();
    await resolveRequestLink({ body: { locator }, user: { id: 10, role_id: 3 } }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.stringify(res.body).includes("request"), false);
  } finally { pool.query = original; }
});

test("copy reuses a valid locator, revoke blocks reuse, and next copy rotates", async () => {
  const originalConnect = pool.connect;
  let share = null;
  const db = {
    release() {},
    async query(sql, params = []) {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("FROM service_requests WHERE id=$1 FOR UPDATE")) return { rows: [{ id: 4, requester_user_id: 10 }], rowCount: 1 };
      if (sql.includes("FROM service_request_shares WHERE service_request_id=$1 FOR UPDATE")) return { rows: share ? [share] : [], rowCount: share ? 1 : 0 };
      if (sql.includes("INSERT INTO service_request_shares")) {
        share = { id: 1, service_request_id: 4, locator: params[1], revoked_at: null, expires_at: null };
        return { rows: [share], rowCount: 1 };
      }
      if (sql.includes("UPDATE service_request_shares SET locator=")) {
        share = { ...share, locator: params[1], revoked_at: null };
        return { rows: [share], rowCount: 1 };
      }
      if (sql.includes("UPDATE service_request_shares SET revoked_at=")) {
        share = { ...share, revoked_at: new Date() };
        return { rows: [{ id: 1 }], rowCount: 1 };
      }
      if (sql.includes("to_regclass('public.admin_audit_logs')")) return { rows: [{ audit_table: null }] };
      if (sql.includes("INSERT INTO public.admin_audit_logs")) throw new Error("Share must not depend on the separate audit table");
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  pool.connect = async () => db;
  try {
    const req = { params: { id: "4" }, user: { id: 10, role_id: 3 } };
    const first = response(); await copyRequestLink(req, first);
    const second = response(); await copyRequestLink(req, second);
    assert.match(first.body.data.locator, /^[0-9a-f]{64}$/);
    assert.equal(second.body.data.locator, first.body.data.locator);
    const revoked = response(); await revokeRequestLink(req, revoked);
    assert.equal(revoked.body.success, true);
    const third = response(); await copyRequestLink(req, third);
    assert.notEqual(third.body.data.locator, first.body.data.locator);
    const stranger = response(); await copyRequestLink({ params: { id: "4" }, user: { id: 11, role_id: 3 } }, stranger);
    assert.equal(stranger.statusCode, 403);
  } finally { pool.connect = originalConnect; }
});

test("concurrent copies serialize on the request and return one locator", async () => {
  const originalConnect = pool.connect;
  let share = null;
  let insertCount = 0;
  let tail = Promise.resolve();
  pool.connect = async () => {
    let unlock;
    return {
      release() {},
      async query(sql, params = []) {
        if (sql === "BEGIN") return { rows: [] };
        if (sql.includes("FROM service_requests WHERE id=$1 FOR UPDATE")) {
          const prior = tail;
          tail = new Promise((resolve) => { unlock = resolve; });
          await prior;
          return { rows: [{ id: 4, requester_user_id: 10 }] };
        }
        if (sql.includes("FROM service_request_shares WHERE service_request_id=$1 FOR UPDATE")) return { rows: share ? [share] : [] };
        if (sql.includes("INSERT INTO service_request_shares")) {
          insertCount++;
          share = { id: 1, locator: params[1], revoked_at: null, expires_at: null };
          return { rows: [share] };
        }
        if (sql.includes("to_regclass('public.admin_audit_logs')")) return { rows: [{ audit_table: null }] };
        if (sql.includes("INSERT INTO public.admin_audit_logs")) throw new Error("Share must not depend on the separate audit table");
        if (sql === "COMMIT" || sql === "ROLLBACK") { unlock?.(); return { rows: [] }; }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
  };
  try {
    const req = { params: { id: "4" }, user: { id: 10, role_id: 3 } };
    const [a, b] = await Promise.all([response(), response()].map(async (res) => { await copyRequestLink(req, res); return res; }));
    assert.equal(a.body.data.locator, b.body.data.locator);
    assert.equal(insertCount, 1);
  } finally { pool.connect = originalConnect; }
});

test("Admin and owner can share requests at any status; another Client cannot", async (t) => {
  const statuses = ["pending", "approved", "completed", "rejected"];
  let currentStatus = statuses[0];
  t.mock.method(pool, "connect", async () => ({
    release() {},
    async query(sql) {
      if (sql.includes("FROM service_requests WHERE id=$1 FOR UPDATE")) return { rows: [{ id: 4, requester_user_id: 10, status: currentStatus }] };
      if (sql.includes("FROM service_request_shares WHERE")) return { rows: [{ locator, revoked_at: null, expires_at: null }] };
      return { rows: [] };
    },
  }));
  for (const role of [1, 3]) for (const status of statuses) {
    currentStatus = status;
    const res = response();
    await copyRequestLink({ params: { id: "4" }, user: { id: role === 1 ? 20 : 10, role_id: role } }, res);
    assert.equal(res.statusCode, 200, `${role} ${status}`);
  }
  const stranger = response();
  await copyRequestLink({ params: { id: "4" }, user: { id: 11, role_id: 3 } }, stranger);
  assert.equal(stranger.statusCode, 403);
});

test("missing share schema is diagnosed separately from a connection outage", async (t) => {
  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });
  t.mock.method(pool, "connect", async () => ({
    release() {},
    async query(sql) {
      if (sql.includes("FROM service_requests WHERE")) return { rows: [{ id: 4, requester_user_id: 10 }] };
      if (sql.includes("FROM service_request_shares WHERE")) throw Object.assign(new Error("private schema detail"), { code: "42P01" });
      return { rows: [] };
    },
  }));
  const req = { params: { id: "4" }, user: { id: 10, role_id: 3 } };
  const schema = response();
  await copyRequestLink(req, schema);
  assert.equal(schema.statusCode, 500);
  assert.equal(schema.body.code, "SHARING_SCHEMA_MISMATCH");
  assert.doesNotMatch(JSON.stringify(schema.body), /private schema detail/);
  pool.connect = async () => { throw Object.assign(new Error("private hostname"), { code: "ENOTFOUND" }); };
  const outage = response();
  await copyRequestLink(req, outage);
  assert.equal(outage.statusCode, 503);
  assert.equal(outage.body.code, "SHARING_UNAVAILABLE");
});
