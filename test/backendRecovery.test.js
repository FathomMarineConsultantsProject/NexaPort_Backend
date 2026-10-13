import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import { pool } from "../src/config/db.js";
import { login } from "../src/controllers/authController.js";
import { getPlatformStats } from "../src/controllers/publicStatsController.js";

const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, set() { return this; }, json(body) { this.body = body; return this; } });
const credentials = { identifier: "test@example.test", password: "Password123" };
const user = { id: 1, email: credentials.identifier, username: "test", full_name: "Test", password_hash: null, role_id: 3, is_active: true };

test("login handles invalid credentials, inactive users and malformed input without a server error", async (t) => {
  const hash = await bcrypt.hash(credentials.password, 4);
  t.mock.method(pool, "query", async () => ({ rows: [{ ...user, password_hash: hash }] }));
  let res = response();
  await login({ body: { ...credentials, password: "wrong" } }, res);
  assert.equal(res.statusCode, 401);
  pool.query = async () => ({ rows: [{ ...user, password_hash: hash, is_active: false }] });
  res = response();
  await login({ body: credentials }, res);
  assert.equal(res.statusCode, 403);
  res = response();
  await login({ body: { identifier: 123, password: "anything" } }, res);
  assert.equal(res.statusCode, 400);
});

test("login and statistics return sanitized 503 for connection failure and timeout", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  t.mock.method(pool, "query", async () => { throw Object.assign(new Error("secret host and credentials"), { code: "ENOTFOUND" }); });
  let res = response();
  await login({ body: credentials }, res);
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.body), /secret host/);
  res = response();
  await getPlatformStats({}, res);
  assert.equal(res.statusCode, 503);
  pool.query = async () => { throw Object.assign(new Error("statement timeout"), { code: "57014" }); };
  res = response();
  await login({ body: credentials }, res);
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(logs), /secret host/);
});

test("idle pool error has a listener and logs only an error code", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  assert.ok(pool.listenerCount("error") > 0);
  pool.emit("error", Object.assign(new Error("secret connection string"), { code: "ECONNRESET" }));
  assert.match(JSON.stringify(logs), /ECONNRESET/);
  assert.doesNotMatch(JSON.stringify(logs), /secret connection string/);
});
