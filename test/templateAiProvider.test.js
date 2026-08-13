import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runTemplateExtraction } from "../src/services/templateExtractionService.js";
import { sanitizeTemplateLabel } from "../src/services/templateFieldSanitizer.js";

const document = { fileName: "fixture.docx", fileType: "docx", extractionMethod: "text", parser: { package: "fixture" }, warnings: [], blocks: [
  { id: "block-0", globalOrder: 0, type: "heading", text: "Vessel Particulars", metadata: {}, location: {} },
  { id: "block-1", globalOrder: 1, type: "paragraph", text: "VESSEL_NAME__", metadata: {}, location: {} },
  { id: "block-2", globalOrder: 2, type: "paragraph", text: "Inspection Date:", metadata: {}, location: {} },
], sections: [], headings: [], paragraphs: [], rows: [], cells: [], lists: [] };

test("template provider compatibility service contains no Gemini execution", async () => {
  const source = await readFile(new URL("../src/services/templateAiProviderService.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Gemini|GoogleGenAI|GEMINI_API_KEY/); assert.match(source, /openrouter/i);
});

test("deterministic label cleanup preserves maritime abbreviations", () => {
  assert.equal(sanitizeTemplateLabel("Inspection Date:"), "Inspection Date"); assert.equal(sanitizeTemplateLabel("VESSEL_NAME__"), "Vessel Name"); assert.equal(sanitizeTemplateLabel("Tank_Pressure___"), "Tank Pressure"); assert.equal(sanitizeTemplateLabel("imoNumber"), "IMO Number"); assert.equal(sanitizeTemplateLabel("MARPOL certificate"), "MARPOL certificate");
});

test("provider unavailability returns deterministic sanitized fields", async () => {
  const result = await runTemplateExtraction({ buffer: Buffer.from("fixture"), originalname: "fixture.docx" }, { sourceType: "docx", parseDocument: async () => document, env: {}, classifyCandidates: async () => { throw Object.assign(new Error("unavailable"), { reason: "configuration_error", attempts: 0 }); } });
  assert.equal(result.degraded, true); assert.equal(result.diagnostics.qualityGate, true); assert.deepEqual(result.fields.map((field) => field.label), ["Vessel Name", "Inspection Date"]); assert.deepEqual(result.fields.map((field) => field.fieldType), ["text", "date"]);
});

test("structured AI output is sanitized and provenance labels are rejected", async () => {
  const result = await runTemplateExtraction({ buffer: Buffer.from("fixture"), originalname: "fixture.docx" }, { sourceType: "docx", parseDocument: async () => document, env: { OPENROUTER_API_KEY: "test" }, classifyCandidates: async (payload) => ({ attempts: 1, modelUsed: "deepseek/test", warnings: [], fields: payload.candidates.map((candidate) => ({ candidateId: candidate.id, include: true, label: candidate.id === "candidate-0" ? "Sheet1!C4" : "Inspection Date:", fieldType: candidate.suggestedType, section: "Vessel Particulars", order: candidate.order, required: false, options: [] })) }) });
  assert.equal(result.diagnostics.qualityGate, true); assert.deepEqual(result.fields.map((field) => field.label), ["Inspection Date"]); assert.equal(result.fields.some((field) => /Sheet1|block-|chunk-/i.test(field.label)), false);
});
