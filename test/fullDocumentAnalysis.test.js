import assert from "node:assert/strict";
import test from "node:test";
import { analyseTemplateSource, normalizeAnalysisInput, validateMapping } from "../src/services/openRouterTemplateService.js";
import { isProvenanceOnlyLabel } from "../src/utils/templateProvenance.js";

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
    { fieldKey: "pumps", label: "Are pumps operable?", fieldType: "yes_no", required: false, sectionKey: "part_b2", sourceOrder: 99, options: ["Yes", "No"], maxPhotos: 1, sourceText: "B2.1 | Are pumps operable? | Yes | No | Remarks", evidenceRefs: ["block-1"], confidence: .98, warning: "" },
    { fieldKey: "invented", label: "Invented", fieldType: "text", required: false, sectionKey: "part_b2", sourceOrder: 0, options: [], maxPhotos: 1, sourceText: "Not present", evidenceRefs: ["block-1"], confidence: .5, warning: "" },
  ], classifications: [{ blockId: "block-0", classification: "section", reason: "Part marker" }, { blockId: "block-1", classification: "field", reason: "Checklist row" }], notes: [], referenceData: [], warnings: [], unmappedBlocks: [] };
  const result = await analyseTemplateSource(input, { env, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }] }) }) });
  assert.deepEqual(result.fields.map((field) => field.fieldKey), ["pumps"]); assert.equal(result.fields[0].sourceOrder, 1); assert.equal(result.classifications.length, 2); assert.match(result.warnings.join(" "), /Dropped/);
});

test("retryable provider failure is retried once", async () => {
  let calls = 0; const context = { ...input, mode: "context" }; const output = { documentTitle: "Checklist", outline: [], glossary: [], responseCodes: [], warnings: [] };
  await analyseTemplateSource(context, { env, fetchImpl: async () => { calls += 1; return calls === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }] }) }; } });
  assert.equal(calls, 2);
});

test("grounded photo fields preserve the AI-selected maximum", async () => {
  const photoInput = { ...input, chunk: { id: "chunk-photo", index: 0, blocks: [{ id: "block-2", globalOrder: 0, partOrder: 0, type: "paragraph", text: "Attach up to 7 photographs", metadata: {}, location: { partIndex: 0 } }] } };
  const output = { documentTitle: "Checklist", sections: [], fields: [{ fieldKey: "photos", label: "Photographs", fieldType: "photo", required: false, sectionKey: "general", sourceOrder: 0, options: [], maxPhotos: 7, sourceText: "Attach up to 7 photographs", evidenceRefs: ["block-2"], confidence: .99, warning: "" }], classifications: [{ blockId: "block-2", classification: "field", reason: "Photo evidence request" }], notes: [], referenceData: [], warnings: [], unmappedBlocks: [] };
  const result = await analyseTemplateSource(photoInput, { env, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }] }) }) });
  assert.equal(result.fields[0].fieldType, "photo"); assert.equal(result.fields[0].maxPhotos, 7);
});

test("2. AI returned field count is tracked", () => {
  const blocks = [{ id: "block-0", globalOrder: 0, text: "Date", location: {} }];
  const result = validateMapping({ sections: [], fields: [{ fieldKey: "date", label: "Date", fieldType: "date", sectionKey: "general", required: false, options: [], order: 0, evidenceRefs: ["block-0"], confidence: .9 }, { fieldKey: "invented", label: "Invented", fieldType: "text", sectionKey: "general", required: false, options: [], order: 1, evidenceRefs: ["block-0"], confidence: .4 }] }, blocks);
  assert.equal(result.diagnostics.rawMappedFields, 2);
});

test("3. Grounded field count is tracked", () => {
  const blocks = [{ id: "block-0", globalOrder: 0, text: "Date", location: {} }];
  const result = validateMapping({ sections: [], fields: [{ fieldKey: "date", label: "Date", fieldType: "date", sectionKey: "general", required: false, options: [], order: 0, evidenceRefs: ["block-0"], confidence: .9 }, { fieldKey: "invented", label: "Invented", fieldType: "text", sectionKey: "general", required: false, options: [], order: 1, evidenceRefs: ["block-0"], confidence: .4 }] }, blocks);
  assert.equal(result.diagnostics.acceptedMappedFields, 1);
});

test("22. Grounding accepts punctuation-normalized source wording", () => {
  const blocks = [{ id: "block-0", globalOrder: 0, text: "Tank LV (Level)", location: {} }];
  const result = validateMapping({ sections: [], fields: [{ fieldKey: "tank_level", label: "Tank LV Level", fieldType: "number", sectionKey: "general", required: false, options: [], order: 0, evidenceRefs: ["block-0"], confidence: .9 }] }, blocks);
  assert.equal(result.fields.length, 1);
});

test("23. Grounding accepts a field supported by multiple cells", () => {
  const blocks = [{ id: "block-0", globalOrder: 0, text: "Manifold", location: {} }, { id: "block-1", globalOrder: 1, text: "Press / Temp (Liq)", location: {} }];
  const result = validateMapping({ sections: [], fields: [{ fieldKey: "manifold_liq", label: "Manifold Press Temp Liq", fieldType: "text", sectionKey: "general", required: false, options: [], order: 0, evidenceRefs: ["block-0", "block-1"], confidence: .9 }] }, blocks);
  assert.equal(result.fields.length, 1); assert.deepEqual(result.fields[0].evidenceRefs, ["block-0", "block-1"]);
});

test("24. Duplicate semantic key across different sections is repaired uniquely", () => {
  const blocks = [{ id: "block-0", globalOrder: 0, text: "No.1 MeOH TK", location: {} }, { id: "block-1", globalOrder: 1, text: "Tank Pressure", location: {} }, { id: "block-2", globalOrder: 2, text: "No.2 MeOH TK", location: {} }, { id: "block-3", globalOrder: 3, text: "Tank Pressure", location: {} }];
  const sections = [{ sectionKey: "no_1", title: "No.1 MeOH TK", order: 0, evidenceRefs: ["block-0"] }, { sectionKey: "no_2", title: "No.2 MeOH TK", order: 2, evidenceRefs: ["block-2"] }];
  const common = { fieldKey: "tank_pressure", label: "Tank Pressure", fieldType: "number", required: false, options: [], confidence: .9 };
  const result = validateMapping({ sections, fields: [{ ...common, sectionKey: "no_1", order: 1, evidenceRefs: ["block-1"] }, { ...common, sectionKey: "no_2", order: 3, evidenceRefs: ["block-3"] }] }, blocks);
  assert.equal(result.fields.length, 2); assert.equal(new Set(result.fields.map((field) => field.fieldKey)).size, 2); assert.match(result.fields[1].fieldKey, /^no_2_/);
});

test("backend trust boundary rejects provenance-only visible labels", () => {
  for (const label of ["A3", "C4", "H65:J65", "block-49", "Cell 1", "header1.xml", "/inspection/section[2]/field[4]", "x: 120, y: 400"]) assert.equal(isProvenanceOnlyLabel(label), true);
  const result = validateMapping({ sections: [], fields: [{ fieldKey: "bad", label: "A3", fieldType: "text", sectionKey: "general", required: false, options: [], order: 0, evidenceRefs: ["block-0"], confidence: .9 }] }, [{ id: "block-0", globalOrder: 0, text: "A3", location: {} }]);
  assert.equal(result.fields.length, 0);
});
