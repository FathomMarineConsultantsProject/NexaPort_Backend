import assert from "node:assert/strict";
import test from "node:test";
import { analyseTemplate, classifyGeminiFailure } from "../src/services/templateAiProviderService.js";

const baseEnv = {
  GEMINI_API_KEY: "gemini-test-key",
  OPENROUTER_API_KEY: "openrouter-test-key",
  TEMPLATE_AI_PRIMARY: "gemini",
  TEMPLATE_AI_FALLBACK: "openrouter",
};

const block = (id, text, globalOrder = Number(id.replace("block-", ""))) => ({ id, globalOrder, partOrder: globalOrder, type: "paragraph", text, metadata: {}, location: {} });
const inputFor = (blocks) => ({ mode: "map", sourceType: "docx", documentTitle: "MeOH Checklist", chunk: { id: "chunk-0", index: 0, blocks }, globalContext: {} });
const outputFor = (blocks, fields, sections = []) => ({
  sections,
  fields,
  warnings: [],
  classifications: blocks.map((item) => ({ blockId: item.id, classification: fields.some((field) => field.evidenceRefs.includes(item.id)) ? "field" : "section", reason: "Grounded source content" })),
});
const aiField = (fieldKey, label, fieldType, sectionKey, evidenceRef, order) => ({ fieldKey, label, fieldType, sectionKey, required: false, options: [], order, evidenceRefs: [evidenceRef] });
const openRouterResponse = (output) => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }] }) });

test("direct Gemini is primary with gemini-3.6-flash and medium thinking", async () => {
  const blocks = [block("block-0", "Inspection Date")]; const output = outputFor(blocks, [aiField("inspection_date", "Inspection Date", "date", "general", "block-0", 0)]);
  let request; let options; let openRouterCalls = 0;
  const result = await analyseTemplate(inputFor(blocks), {
    env: baseEnv,
    geminiClient: { interactions: { create: async (nextRequest, nextOptions) => { request = nextRequest; options = nextOptions; return { output_text: JSON.stringify(output) }; } } },
    fetchImpl: async () => { openRouterCalls += 1; throw new Error("must not call fallback"); },
  });
  assert.equal(request.model, "gemini-3.6-flash");
  assert.equal(request.generation_config.thinking_level, "medium");
  assert.equal(request.generation_config.max_output_tokens, 8192);
  assert.equal(request.response_format.mime_type, "application/json");
  assert.equal(options.maxRetries, 0);
  assert.equal(result.providerUsed, "gemini"); assert.equal(result.fields.length, 1); assert.equal(result.fallbackUsed, false); assert.equal(openRouterCalls, 0);
});

for (const [name, failure] of [
  ["HTTP 429", Object.assign(new Error("rate limit"), { status: 429 })],
  ["RESOURCE_EXHAUSTED", Object.assign(new Error("resource exhausted"), { code: "RESOURCE_EXHAUSTED" })],
  ["quota exhausted", new Error("quota exhausted")],
]) test(`Gemini ${name} invokes OpenRouter without wasting a Gemini retry`, async () => {
  const blocks = [block("block-0", "Other Remarks")]; const output = outputFor(blocks, [aiField("remarks", "Other Remarks", "textarea", "general", "block-0", 0)]);
  let geminiCalls = 0; let openRouterBody;
  const result = await analyseTemplate(inputFor(blocks), {
    env: baseEnv,
    geminiClient: { interactions: { create: async () => { geminiCalls += 1; throw failure; } } },
    fetchImpl: async (_url, options) => { openRouterBody = JSON.parse(options.body); return openRouterResponse(output); },
  });
  assert.equal(geminiCalls, 1); assert.equal(result.providerUsed, "openrouter"); assert.equal(result.fallbackUsed, true);
  assert.equal(openRouterBody.model, "google/gemini-3.5-flash"); assert.deepEqual(openRouterBody.reasoning, { effort: "medium" }); assert.equal(openRouterBody.max_tokens, 8192);
});

for (const [name, failure] of [
  ["transient 503", Object.assign(new Error("service unavailable"), { status: 503 })],
  ["network failure", Object.assign(new Error("fetch failed"), { code: "ECONNRESET" })],
  ["timeout", Object.assign(new Error("timed out"), { name: "TimeoutError" })],
]) test(`Gemini ${name} retries once and then falls back`, async () => {
  const blocks = [block("block-0", "Checked By (Sign)")]; const output = outputFor(blocks, [aiField("checked_by", "Checked By (Sign)", "signature", "general", "block-0", 0)]);
  let geminiCalls = 0; let fallbackCalls = 0;
  const result = await analyseTemplate(inputFor(blocks), {
    env: baseEnv, sleep: async () => {},
    geminiClient: { interactions: { create: async () => { geminiCalls += 1; throw failure; } } },
    fetchImpl: async () => { fallbackCalls += 1; return openRouterResponse(output); },
  });
  assert.equal(geminiCalls, 2); assert.equal(fallbackCalls, 1); assert.equal(result.fields[0].fieldType, "signature");
});

test("missing or invalid Gemini credentials never consume OpenRouter", async () => {
  let fallbackCalls = 0; const fetchImpl = async () => { fallbackCalls += 1; throw new Error("must not call"); };
  await assert.rejects(() => analyseTemplate(inputFor([block("block-0", "Date")]), { env: { ...baseEnv, GEMINI_API_KEY: "" }, fetchImpl }), /primary API key is missing/);
  await assert.rejects(() => analyseTemplate(inputFor([block("block-0", "Date")]), { env: baseEnv, geminiClient: { interactions: { create: async () => { throw Object.assign(new Error("API key is invalid"), { status: 401 }); } } }, fetchImpl }), /configuration error/);
  assert.equal(fallbackCalls, 0);
});

test("MeOH repeated section fields, textarea and signature survive while provenance labels are blocked", async () => {
  const texts = ["No.1 MeOH TK", "Tank Pressure", "Tank Volume", "Tank Temp", "No.2 MeOH TK", "Tank Pressure", "Tank Volume", "Tank Temp", "No.3 MeOH TK", "Tank Pressure", "Tank Volume", "Tank Temp", "Other Operational Parameters", "Other Remarks", "Checked By (Sign)", "A3", "header1.xml"];
  const blocks = texts.map((text, index) => block(`block-${index}`, text, index));
  const sections = [["no_1_meoh_tk", "No.1 MeOH TK", 0], ["no_2_meoh_tk", "No.2 MeOH TK", 4], ["no_3_meoh_tk", "No.3 MeOH TK", 8], ["other", "Other Operational Parameters", 12]].map(([sectionKey, title, order]) => ({ sectionKey, title, order, evidenceRefs: [`block-${order}`] }));
  const fields = [];
  for (const [sectionKey, offset] of [["no_1_meoh_tk", 1], ["no_2_meoh_tk", 5], ["no_3_meoh_tk", 9]]) {
    fields.push(aiField("tank_pressure", "Tank Pressure", "number", sectionKey, `block-${offset}`, offset));
    fields.push(aiField("tank_volume", "Tank Volume", "number", sectionKey, `block-${offset + 1}`, offset + 1));
    fields.push(aiField("tank_temp", "Tank Temp", "number", sectionKey, `block-${offset + 2}`, offset + 2));
  }
  fields.push(aiField("other_remarks", "Other Remarks", "textarea", "other", "block-13", 13), aiField("checked_by", "Checked By (Sign)", "signature", "other", "block-14", 14), aiField("a3", "A3", "text", "other", "block-15", 15), aiField("header", "header1.xml", "text", "other", "block-16", 16));
  const result = await analyseTemplate(inputFor(blocks), { env: baseEnv, geminiClient: { interactions: { create: async () => ({ output_text: JSON.stringify(outputFor(blocks, fields, sections)) }) } } });
  assert.equal(result.fields.filter((field) => field.label === "Tank Pressure").length, 3);
  assert.equal(result.fields.filter((field) => field.label === "Tank Volume").length, 3);
  assert.equal(result.fields.filter((field) => field.label === "Tank Temp").length, 3);
  assert.equal(new Set(result.fields.map((field) => field.fieldKey)).size, result.fields.length);
  assert.equal(result.fields.find((field) => field.label === "Other Remarks").fieldType, "textarea");
  assert.equal(result.fields.find((field) => field.label === "Checked By (Sign)").fieldType, "signature");
  assert.deepEqual(result.fields.filter((field) => ["A3", "header1.xml"].includes(field.label)), []);
});

test("a compact 56-block document uses one Gemini request and preserves all accepted fields", async () => {
  const blocks = Array.from({ length: 56 }, (_, index) => block(`block-${index}`, `Reading ${index + 1}`, index));
  const fields = blocks.slice(0, 30).map((item, index) => aiField(`reading_${index + 1}`, item.text, "text", "general", item.id, index));
  let calls = 0;
  const result = await analyseTemplate(inputFor(blocks), { env: baseEnv, geminiClient: { interactions: { create: async () => { calls += 1; return { output_text: JSON.stringify(outputFor(blocks, fields)) }; } } } });
  assert.equal(calls, 1); assert.equal(result.fields.length, 30);
});

test("Gemini failure classification separates fallback conditions from application and auth errors", () => {
  assert.equal(classifyGeminiFailure({ status: 429 }).fallbackAllowed, true);
  assert.equal(classifyGeminiFailure({ status: 503 }).retry, true);
  assert.equal(classifyGeminiFailure({ status: 401 }).fallbackAllowed, false);
  assert.equal(classifyGeminiFailure(new Error("API key not valid. Please pass a valid API key.")).reason, "authentication_error");
  assert.equal(classifyGeminiFailure(new TypeError("programmer error")).fallbackAllowed, false);
});
