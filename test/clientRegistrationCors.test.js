import assert from "node:assert/strict";
import test from "node:test";
import cors from "cors";
import { corsOptions } from "../src/app.js";
import { createRequireAuth } from "../src/middlewares/authMiddleware.js";

const preflight = (path, origin = "http://localhost:5173") => {
  const headers = new Map();
  const response = { statusCode: 200, ended: false,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    end() { this.ended = true; } };
  let nextCalled = false;
  cors(corsOptions)({ method: "OPTIONS", url: path, headers: {
    origin, "access-control-request-method": "POST",
    "access-control-request-headers": "authorization,content-type,x-registration-draft-token",
  } }, response, () => { nextCalled = true; });
  return { response, headers, nextCalled };
};

for (const path of [
  "/api/admin/client-registrations/create/documents/upload-url",
  "/api/admin/client-registrations/create/documents/confirm",
  "/api/admin/client-registrations/create/submit",
  "/api/auth/client-registration/documents/upload-url",
  "/api/auth/client-registration/documents/confirm",
  "/api/auth/register-client",
]) test(`registration preflight allows draft token and Admin authentication: ${path}`, () => {
  const { response, headers, nextCalled } = preflight(path);
  assert.equal(response.statusCode, 204);
  assert.equal(response.ended, true);
  assert.equal(nextCalled, false);
  assert.equal(headers.get("access-control-allow-origin"), "http://localhost:5173");
  const permitted = headers.get("access-control-allow-headers").toLowerCase().split(/\s*,\s*/);
  for (const name of ["authorization", "content-type", "x-registration-draft-token"]) assert.ok(permitted.includes(name));
  assert.ok(headers.get("access-control-allow-methods").includes("POST"));
});

test("registration header does not allow untrusted origins", () => {
  const { headers } = preflight("/api/admin/client-registrations/create/submit", "https://untrusted.example");
  assert.equal(headers.get("access-control-allow-origin"), undefined);
});

test("draft token alone still cannot authorize an Admin registration request", async () => {
  let continued = false;
  const response = { status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
  const guard = createRequireAuth({ queryUser() { throw new Error("Database should not be queried without authentication"); } });
  await guard({ headers: { "x-registration-draft-token": "registration-only" } }, response, () => { continued = true; });
  assert.equal(response.statusCode, 401);
  assert.equal(continued, false);
});
