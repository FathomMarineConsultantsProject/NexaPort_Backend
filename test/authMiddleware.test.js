import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import jwt from "jsonwebtoken";
import { createRequireAuth } from "../src/middlewares/authMiddleware.js";

const TEST_SECRET = "auth-middleware-test-secret";
const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});
const middleware = (overrides = {}) => createRequireAuth({
  verifyToken: (token) => jwt.verify(token, TEST_SECRET),
  queryUser: async () => ({ rows: [{ id: 7, role_id: 2, is_active: true }] }),
  logError: () => {},
  ...overrides,
});

test("missing Authorization header returns 401", async () => {
  const res = response();
  await middleware()({ headers: {} }, res, () => assert.fail("request passed"));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.message, "Authorization token required");
});

test("malformed or invalid JWT returns 401", async () => {
  const res = response();
  await middleware()({ headers: { authorization: "Bearer not-a-jwt" } }, res, () => assert.fail("request passed"));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.message, "Invalid or expired token");
});

test("expired JWT returns 401", async () => {
  const token = jwt.sign({ id: 7, exp: Math.floor(Date.now() / 1000) - 10 }, TEST_SECRET);
  const res = response();
  await middleware()({ headers: { authorization: `Bearer ${token}` } }, res, () => assert.fail("request passed"));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.message, "Invalid or expired token");
});

test("database lookup failure returns a credential-safe 503", async () => {
  const token = jwt.sign({ id: 7 }, TEST_SECRET);
  const logs = [];
  const queryError = Object.assign(
    new Error("connect ECONNREFUSED postgres://secret-user:secret-password@db.internal:5432/nexaport"),
    { code: "ECONNREFUSED" }
  );
  const res = response();
  await middleware({
    queryUser: async () => { throw queryError; },
    logError: (...args) => logs.push(args),
  })({ headers: { authorization: `Bearer ${token}` } }, res, () => assert.fail("request passed"));

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    success: false,
    message: "Authentication service temporarily unavailable",
  });
  assert.doesNotMatch(JSON.stringify(res.body), /invalid or expired token|secret-user|secret-password|db\.internal/i);
  assert.doesNotMatch(JSON.stringify(logs), /secret-user|secret-password|db\.internal/i);
  assert.match(JSON.stringify(logs), /database_unavailable|ECONNREFUSED/);
});

test("valid token and active mocked user continue normally", async () => {
  const token = jwt.sign({ id: 7 }, TEST_SECRET);
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = response();
  let nextCalled = false;
  await middleware()(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.user, { id: 7, role_id: 2, is_active: true });
});

test("server bootstrap loads dotenv before dynamically importing the app", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import app from/m);
  assert.match(source, /dotenv\.config\(\);[\s\S]*await import\("\.\/app\.js"\)/);
  assert.ok(source.indexOf("dotenv.config();") < source.indexOf('await import("./app.js")'));
});
