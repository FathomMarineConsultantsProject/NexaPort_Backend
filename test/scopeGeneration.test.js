import assert from "node:assert/strict";
import test from "node:test";
import { resolveScopeInput, generateScope } from "../src/services/scopeGenerationService.js";
import { createScopeGenerationController } from "../src/controllers/scopeGenerationController.js";
import router from "../src/routes/serviceRequestRoutes.js";
import { createRequireAuth, allowRoles } from "../src/middlewares/authMiddleware.js";
import { requireApprovedClient } from "../src/middlewares/clientApprovalMiddleware.js";
import { pool } from "../src/config/db.js";
const response = () => ({ statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });
const env = { OPENROUTER_API_KEY: "test-secret", OPENROUTER_SCOPE_MODEL: "deepseek/deepseek-chat" };

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

test("mocked OpenRouter returns only editable scopeOfWork and uses shared backend key", async () => {
  const result = await generateScope({ keywords: "hull" }, { env, fetchImpl: async (url, options) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions"); assert.equal(options.headers.Authorization, "Bearer test-secret");
    assert.equal(JSON.parse(options.body).response_format.json_schema.name, "nexaport_scope");
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ scopeOfWork: " Inspect hull and machinery. " }) } }] }) };
  } });
  assert.deepEqual(result, { scopeOfWork: "Inspect hull and machinery." });
});

test("provider failures, timeout and invalid output remain safe and bounded", async () => {
  for (const status of [401, 402, 429, 500]) await assert.rejects(generateScope({}, { env, fetchImpl: async () => ({ ok: false, status, json: async () => ({ error: "test-secret" }) }) }), (error) => !error.message.includes("test-secret") && [429, 503].includes(error.status));
  await assert.rejects(generateScope({}, { env, timeoutMs: 1, fetchImpl: async (_, { signal }) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(resolve, 50); signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(new Error("test-secret")); }, { once: true });
  }) }), /timed out/);
  for (const content of ["broken", JSON.stringify({ scopeOfWork: "x".repeat(12001) }), JSON.stringify({ scopeOfWork: "Scope", secret: "extra" })]) await assert.rejects(generateScope({}, { env, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) }) }), (error) => error.status === 502);
});

test("per-user throttle limits requests, isolates users and resets; unknown errors do not leak", async () => {
  let time = 0; const controller = createScopeGenerationController({ now: () => time, limit: 1, windowMs: 100, generate: async () => ({ scopeOfWork: "Scope" }) });
  const call = async (id) => { const res = response(); await controller({ user: { id }, body: { keywords: "hull" } }, res); return res; };
  assert.equal((await call(1)).statusCode, 200); assert.equal((await call(1)).statusCode, 429); assert.equal((await call(2)).statusCode, 200);
  time = 101; assert.equal((await call(1)).statusCode, 200);
  const failing = createScopeGenerationController({ generate: async () => { throw new Error("secret and stack"); } }); const res = response(); await failing({ user: { id: 1 }, body: { keywords: "hull" } }, res);
  assert.equal(res.statusCode, 503); assert.doesNotMatch(JSON.stringify(res.body), /secret|stack/);
});
