import assert from "node:assert/strict";
import test from "node:test";
import { analyseTemplateSource, normalizeAnalysisInput } from "../src/services/openRouterTemplateService.js";

const input = { mode: "map", sourceType: "docx", documentTitle: "Checklist", chunk: { id: "chunk-0", index: 0, blocks: [
  { id: "block-0", globalOrder: 0, partOrder: 0, type: "paragraph", text: "Part B2", metadata: {}, location: { partIndex: 0 } },
  { id: "block-1", globalOrder: 1, partOrder: 1, type: "table_row", text: "B2.1 | Are pumps operable? | Yes | No | Remarks", metadata: { cells: ["B2.1", "Are pumps operable?", "Yes", "No", "Remarks"] }, location: { tableIndex: 0, rowIndex: 1 } },
] }, globalContext: { responseCodes: [{ code: "Y", meaning: "Yes" }] } };
const env = { OPENROUTER_API_KEY: "test", OPENROUTER_TEMPLATE_MODEL: "test/model" };

test("structured input rejects source bytes and accepts grounded blocks", () => {
  assert.equal(normalizeAnalysisInput(input).chunk.blocks.length, 2);
  assert.throws(() => normalizeAnalysisInput({ ...input, bytes: [1] }), /bytes and files/);
});

test("mapping classifies every block, drops only an ungrounded field, and uses source order", async () => {
  const output = { documentTitle: "Checklist", sections: [{ sectionKey: "part_b2", title: "Part B2", sourceOrder: 99, evidenceRefs: ["block-0"] }], fields: [
    { fieldKey: "pumps", label: "Are pumps operable?", fieldType: "yes_no", required: false, sectionKey: "part_b2", sourceOrder: 99, options: ["Yes", "No"], sourceText: "B2.1 | Are pumps operable? | Yes | No | Remarks", evidenceRefs: ["block-1"], confidence: .98, warning: "" },
    { fieldKey: "invented", label: "Invented", fieldType: "text", required: false, sectionKey: "part_b2", sourceOrder: 0, options: [], sourceText: "Not present", evidenceRefs: ["block-1"], confidence: .5, warning: "" },
  ], classifications: [{ blockId: "block-0", classification: "section", reason: "Part marker" }, { blockId: "block-1", classification: "field", reason: "Checklist row" }], notes: [], referenceData: [], warnings: [], unmappedBlocks: [] };
  const result = await analyseTemplateSource(input, { env, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }] }) }) });
  assert.deepEqual(result.fields.map((field) => field.fieldKey), ["pumps"]); assert.equal(result.fields[0].sourceOrder, 1); assert.equal(result.classifications.length, 2); assert.match(result.warnings.join(" "), /Dropped/);
});

test("retryable provider failure is retried once", async () => {
  let calls = 0; const context = { ...input, mode: "context" }; const output = { documentTitle: "Checklist", outline: [], glossary: [], responseCodes: [], warnings: [] };
  await analyseTemplateSource(context, { env, fetchImpl: async () => { calls += 1; return calls === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }] }) }; } });
  assert.equal(calls, 2);
});
