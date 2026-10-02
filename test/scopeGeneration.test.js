import assert from "node:assert/strict";
import test from "node:test";
import { resolveScopeInput, generateScope } from "../src/services/scopeGenerationService.js";
import { resolveScopeProviderConfig, DEFAULT_SCOPE_MODEL } from "../src/services/openRouterScopeService.js";
import { createScopeGenerationController } from "../src/controllers/scopeGenerationController.js";
import router from "../src/routes/serviceRequestRoutes.js";
import { createRequireAuth, allowRoles } from "../src/middlewares/authMiddleware.js";
import { requireApprovedClient } from "../src/middlewares/clientApprovalMiddleware.js";
import { pool } from "../src/config/db.js";
import express from "express";
import jwt from "jsonwebtoken";
const response = () => ({ statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });
const env = { OPENROUTER_API_KEY: "test-secret", OPENROUTER_MODEL: "gemini-test-model" };

test("scope uses only the OpenRouter key and ignores all deployed model overrides", () => {
  const deployed = { OPENROUTER_API_KEY: "test-secret", OPENROUTER_TEMPLATE_MODEL: "models/gemini-template-test" };
  assert.equal(resolveScopeProviderConfig(deployed).model, DEFAULT_SCOPE_MODEL);
  assert.equal(resolveScopeProviderConfig({ ...deployed, OPENROUTER_MODEL: "invalid-model" }).model, DEFAULT_SCOPE_MODEL);
  assert.equal(resolveScopeProviderConfig({ OPENROUTER_API_KEY: "test-secret" }).model, DEFAULT_SCOPE_MODEL);
});

test("HTTP scope endpoint enforces auth, returns OpenRouter scope and structured configuration errors", async () => {
  const originalQuery = pool.query, originalFetch = globalThis.fetch;
  const savedEnv = Object.fromEntries(["JWT_SECRET", "OPENROUTER_API_KEY", "OPENROUTER_MODEL"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { JWT_SECRET: "request-test-jwt", OPENROUTER_API_KEY: "request-test-gemini", OPENROUTER_MODEL: "gemini-test-model" });
  pool.query = async (sql) => {
    if (/SELECT id, full_name/.test(sql)) return { rows: [{ id: 501, role_id: 3, full_name: "Client", is_active: true }] };
    if (/to_regclass/.test(sql)) return { rows: [{ membership_table: null }] };
    if (/verification_status/.test(sql)) return { rows: [{ is_active: true, verification_status: "approved" }] };
    throw new Error("Unexpected database query in request test");
  };
  let providerCalls = 0;
  globalThis.fetch = async (url) => {
    assert.ok(url.startsWith("https://openrouter.ai/api/v1/chat/completions"));
    providerCalls += 1;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: "Inspect hull and machinery." } }] }) };
  };
  const app = express(); app.use(express.json()); app.use("/api/service-requests", router);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const url = `http://127.0.0.1:${server.address().port}/api/service-requests/generate-scope`;
    const token = jwt.sign({ id: 501 }, process.env.JWT_SECRET);
    const send = (body, authenticated = true) => originalFetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.equal((await send({ keywords: "hull" }, false)).status, 401);
    const invalid = await send({ keywords: "" }); assert.equal(invalid.status, 400);
    const good = await send({ keywords: "hull" }); assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), { success: true, scopeOfWork: "Inspect hull and machinery." });
    delete process.env.OPENROUTER_API_KEY;
    const unconfigured = await send({ keywords: "hull" }); assert.equal(unconfigured.status, 503);
    assert.equal((await unconfigured.json()).code, "AI_PROVIDER_NOT_CONFIGURED");
    assert.equal(providerCalls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    pool.query = originalQuery; globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("scope route precedes parameter routes and uses request auth, approval and roles", () => {
  const index = router.stack.findIndex((layer) => layer.route?.path === "/generate-scope");
  assert.ok(index >= 0 && index < router.stack.findIndex((layer) => layer.route?.path === "/:id"));
  assert.deepEqual(router.stack[index].route.stack.map((layer) => layer.handle.name), ["", "requireApprovedClient", "", ""]);
});

test("auth is required and Admin/approved Client allowed; pending Client and Consultant forbidden", async () => {
  const unauth = response(); await createRequireAuth()({ headers: {} }, unauth, () => assert.fail("Unauthenticated")); assert.equal(unauth.statusCode, 401);
  const original = pool.query;
  try {
    for (const [role, approved] of [[1, false], [3, true], [3, false], [2, true]]) {
      pool.query = async () => ({ rows: [{ is_active: true, verification_status: approved ? "approved" : "pending" }] });
      const req = { user: { id: 1, role_id: role } }, res = response(); let passed = false;
      await requireApprovedClient(req, res, () => allowRoles(1, 3)(req, res, () => { passed = true; }));
      assert.equal(passed, role === 1 || (role === 3 && approved));
      if (!passed) assert.equal(res.statusCode, 403);
    }
  } finally { pool.query = original; }
});

test("scope context resolves canonical IDs and excludes untrusted categories/private fields", async () => {
  const context = await resolveScopeInput({ keywords: " hull machinery ", inspectionMethodId: 7, serviceType: "Spoof", category: "Spoof", portId: 5, portName: "Spoof", agentEmail: "private@example.com", vesselType: "Bulk Carrier" }, { query: async (sql) => ({ rows: /inspection_methods/.test(sql) ? [{ name: "Pre-Purchase Inspections", vertical_name: "Vessel Condition" }] : [{ port_name: "Singapore" }] }) });
  assert.equal(context.service, "Pre-Purchase Inspections"); assert.equal(context.portName, "Singapore"); assert.equal(context.keywords, "hull machinery");
  assert.equal(context.agentEmail, undefined); assert.equal(context.category, undefined);
});

test("keywords/context are bounded and invalid method/Port rejected before provider", async () => {
  const db = { query: async () => ({ rows: [] }) };
  for (const body of [{ keywords: "" }, { keywords: "x".repeat(1001) }, { keywords: [] }, { keywords: "scope", existingScope: "x".repeat(12001) }, { keywords: "scope", inspectionMethodId: 999 }, { keywords: "scope", portId: 999 }]) await assert.rejects(resolveScopeInput(body, db), (error) => error.status === 400);
});


test("mocked OpenRouter extracts visible text parts, sends context and keeps the key only in headers", async () => {
  const result = await generateScope({ keywords: "hull", service: "Pre-Purchase Inspections", terminalName: "A" }, { env, fetchImpl: async (url, options) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-secret");
    assert.ok(!url.includes("test-secret"));
    const payload = JSON.parse(options.body);
    assert.deepEqual({ model: payload.model, max_tokens: payload.max_tokens, reasoning: payload.reasoning }, { model: DEFAULT_SCOPE_MODEL, max_tokens: 3000, reasoning: { enabled: false } });
    assert.equal(JSON.parse(payload.messages[1].content).terminalName, "A");
    assert.match(payload.messages[0].content, /selected service as primary context/);
    assert.ok(!options.body.includes("test-secret"));
    return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: " Inspect hull and machinery. " } }] }) };
  } });
  assert.deepEqual(result, { scopeOfWork: "Inspect hull and machinery." });
});

test("missing OpenRouter key fails before provider invocation and Gemini config is insufficient", async () => {
  let called = false;
  await assert.rejects(generateScope({}, { env: { GEMINI_API_KEY: "unrelated-key" }, fetchImpl: async () => { called = true; } }), (error) => error.status === 503 && error.code === "AI_PROVIDER_NOT_CONFIGURED");
  assert.equal(called, false);
});

test("OpenRouter failures and invalid output return safe structured provider errors", async () => {
  const codes = { 400: "AI_PROVIDER_REQUEST_REJECTED", 401: "AI_PROVIDER_AUTH_FAILED", 402: "AI_PROVIDER_PAYMENT_REQUIRED", 403: "AI_PROVIDER_ACCESS_DENIED", 404: "AI_PROVIDER_MODEL_UNAVAILABLE", 429: "AI_PROVIDER_RATE_LIMITED", 500: "AI_PROVIDER_ERROR" };
  for (const [statusValue, code] of Object.entries(codes)) {
    const status = Number(statusValue);
    await assert.rejects(generateScope({}, { env, fetchImpl: async () => ({ ok: false, status, json: async () => ({ error: "test-secret" }) }) }), (error) => error.code === code && error.providerStatus === status && !error.message.includes("test-secret") && error.status === (status === 429 ? 429 : [401, 402, 403, 404].includes(status) ? 503 : 502));
  }
  await assert.rejects(generateScope({}, { env, fetchImpl: async () => { throw new Error("Headers test-secret stack"); } }), (error) => error.status === 502 && error.code === "AI_PROVIDER_CONNECTION_ERROR" && !error.message.includes("test-secret"));
  for (const content of [{}, { choices: [] }, { choices: [{ finish_reason: "length", message: { content: "Partial scope" } }] }, { choices: [{ message: { content: "x".repeat(12001) } }] }, { choices: [{ message: { content: "test-secret" } }] }]) await assert.rejects(generateScope({}, { env, fetchImpl: async () => ({ ok: true, json: async () => content }) }), (error) => error.status === 502 && error.code === "AI_PROVIDER_INVALID_RESPONSE");
});

test("timeout covers unresponsive provider and body parsing, even if transport ignores abort", async () => {
  for (const fetchImpl of [async () => new Promise(() => {}), async () => ({ ok: true, json: async () => new Promise(() => {}) })]) {
    await assert.rejects(generateScope({}, { env, timeoutMs: 5, fetchImpl }), (error) => error.status === 504 && error.code === "AI_PROVIDER_TIMEOUT");
  }
});

test("controller calls OpenRouter with canonical context and returns success without provider metadata", async () => {
  let received;
  const controller = createScopeGenerationController({ queryable: { query: async () => ({ rows: [{ name: "Pre-Purchase Inspections", vertical_name: "Vessel Condition" }] }) }, generate: async (context) => { received = context; return { scopeOfWork: "Scope" }; } });
  const res = response();
  await controller({ user: { id: 7 }, body: { keywords: "hull", inspectionMethodId: 1, vesselType: "Bulk Carrier" } }, res);
  assert.equal(received.service, "Pre-Purchase Inspections");
  assert.deepEqual(res.body, { success: true, scopeOfWork: "Scope" });
});

test("controller returns safe config error and logs only structured diagnostics", async () => {
  const logs = [];
  const controller = createScopeGenerationController({ generate: (context) => generateScope(context, { env: {} }), logError: (...args) => logs.push(args) });
  const res = response(); await controller({ user: { id: 1 }, body: { keywords: "hull" } }, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { success: false, code: "AI_PROVIDER_NOT_CONFIGURED", message: "AI scope generation is temporarily unavailable." });
  assert.equal(logs[0][1].code, "AI_PROVIDER_NOT_CONFIGURED");
  assert.doesNotMatch(JSON.stringify(logs), /apiKey|headers|stack/);
});

test("per-user throttle limits requests, isolates users and resets; unknown errors do not leak", async () => {
  let time = 0; const controller = createScopeGenerationController({ now: () => time, limit: 1, windowMs: 100, generate: async () => ({ scopeOfWork: "Scope" }) });
  const call = async (id) => { const res = response(); await controller({ user: { id }, body: { keywords: "hull" } }, res); return res; };
  assert.equal((await call(1)).statusCode, 200); assert.equal((await call(1)).statusCode, 429); assert.equal((await call(2)).statusCode, 200);
  time = 101; assert.equal((await call(1)).statusCode, 200);
  const failing = createScopeGenerationController({ generate: async () => { throw new Error("secret and stack"); }, logError() {} }); const res = response(); await failing({ user: { id: 1 }, body: { keywords: "hull" } }, res);
  assert.equal(res.statusCode, 503); assert.doesNotMatch(JSON.stringify(res.body), /secret|stack/);
});
