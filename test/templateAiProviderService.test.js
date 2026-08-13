import assert from "node:assert/strict";
import test from "node:test";
import { classifyCandidatesWithDeepSeek, resolveDeepSeekConfig } from "../src/services/deepSeekTemplateService.js";

const payload = { section: "General", context: ["Vessel particulars"], candidates: [{ id: "candidate-0", sourceText: "Inspection Date:", suggestedLabel: "Inspection Date", suggestedType: "date", order: 1, context: [] }] };
const output = { fields: [{ candidateId: "candidate-0", include: true, label: "Inspection Date", fieldType: "date", section: "General", order: 1, required: false, options: [] }], warnings: [] };
const ok = () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }] }) });
const env = { OPENROUTER_API_KEY: "test", OPENROUTER_TEMPLATE_MODEL: "deepseek/primary", OPENROUTER_TEMPLATE_FALLBACK_MODEL: "deepseek/secondary", OPENROUTER_TEMPLATE_REASONING_EFFORT: "low" };

test("DeepSeek classification uses OpenRouter once and sends only compact candidates", async () => {
  let body; const result = await classifyCandidatesWithDeepSeek(payload, { env, fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return ok(); } });
  assert.equal(result.attempts, 1); assert.equal(result.modelUsed, "deepseek/primary"); assert.equal(body.model, "deepseek/primary");
  assert.deepEqual(JSON.parse(body.messages[1].content), payload); assert.equal(body.response_format.type, "json_schema"); assert.deepEqual(body.provider, { require_parameters: true, zdr: true });
});

test("non-DeepSeek routes are rejected before a provider call", async () => {
  assert.throws(() => resolveDeepSeekConfig({ OPENROUTER_TEMPLATE_MODEL: "openai/gpt-5", OPENROUTER_TEMPLATE_FALLBACK_MODEL: "deepseek/secondary" }), /must be DeepSeek/);
});

test("402 is not retried", async () => { let calls = 0; await assert.rejects(() => classifyCandidatesWithDeepSeek(payload, { env, fetchImpl: async () => { calls += 1; return { ok: false, status: 402 }; } }), (error) => error.reason === "payment_required" && error.attempts === 1); assert.equal(calls, 1); });
test("403 switches directly to the secondary DeepSeek route", async () => { const models = []; const result = await classifyCandidatesWithDeepSeek(payload, { env, fetchImpl: async (_url, options) => { const model = JSON.parse(options.body).model; models.push(model); return model === "deepseek/primary" ? { ok: false, status: 403 } : ok(); } }); assert.deepEqual(models, ["deepseek/primary", "deepseek/secondary"]); assert.equal(result.attempts, 2); });
test("429 performs one primary retry and one secondary attempt at most", async () => { const models = []; await assert.rejects(() => classifyCandidatesWithDeepSeek(payload, { env, sleep: async () => {}, fetchImpl: async (_url, options) => { models.push(JSON.parse(options.body).model); return { ok: false, status: 429 }; } }), (error) => error.attempts === 3); assert.deepEqual(models, ["deepseek/primary", "deepseek/primary", "deepseek/secondary"]); });
test("a 402 encountered after a transient retry stops without a secondary charge attempt", async () => { let calls = 0; await assert.rejects(() => classifyCandidatesWithDeepSeek(payload, { env, sleep: async () => {}, fetchImpl: async () => ({ ok: false, status: ++calls === 1 ? 503 : 402 }) }), (error) => error.reason === "payment_required" && error.attempts === 2); assert.equal(calls, 2); });
