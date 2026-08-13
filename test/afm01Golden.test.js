import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { runTemplateExtraction } from "../src/services/templateExtractionService.js";

const sourcePath = process.env.AFM01_GOLDEN_PATH || "C:/Users/Krish/Downloads/60. AFM01 - Methanol Bunkering Alongside A Berth 1.docx";

test("actual AFM01 document preserves semantic hierarchy and rejects navigation fields", { skip: !existsSync(sourcePath) }, async () => {
  const result = await runTemplateExtraction({ buffer: readFileSync(sourcePath), originalname: "60. AFM01 - Methanol Bunkering Alongside A Berth 1.docx", mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, { sourceType: "docx", env: {} });
  const sectionTitles = new Set(result.sections.map((section) => section.title));
  for (const required of ["Preparation", "Pre-operation", "Alignment and Agreement", "Connection Testing", "Transfer", "Post Operation", "Declarations"]) assert.ok(sectionTitles.has(required), `missing ${required}`);
  for (const code of ["B1", "B2", "B3", "C1", "C2", "C3", "C4", "C5", "D1", "D2", "E1", "E2", "E3", "F1", "F2", "F3"]) assert.ok([...sectionTitles].some((title) => title.startsWith(`${code} —`)), `missing ${code}`);
  assert.ok(result.fields.length >= 180);
  assert.ok(result.fields.filter((field) => ["yes_no", "select", "checkbox"].includes(field.fieldType)).length >= 120);
  assert.equal(result.fields.some((field) => /^(?:part\s*)?[A-F](?:\d+)?\s*:?$|^(?:time|tank|status|check|code)$/i.test(field.label)), false);
  assert.ok(result.fields.some((field) => field.label === "Bunker Identification Number (BIN)"));
  assert.ok(result.fields.some((field) => /Bunker vessel Signature/i.test(field.label) && field.fieldType === "signature"));
  assert.ok(result.fields.some((field) => /Receiving vessel Date and time/i.test(field.label) && field.fieldType === "date"));
  assert.equal(result.fields.filter((field) => /^C[34]\b/.test(field.section)).some((field) => /^Tank:?$/i.test(field.label)), false);
  assert.ok(result.fields.some((field) => /^C2\b/.test(field.section) && field.label === "Electrical insulation"));
  assert.ok(result.fields.some((field) => /^C5\b/.test(field.section) && field.label === "Max transfer rate" && field.fieldType === "number"));
  console.info("AFM01_GOLDEN", JSON.stringify({ parse: true, candidates: result.diagnostics.candidateCount, finalFieldCount: result.fields.length, sectionCount: result.sections.length, badProvenanceLabels: result.fields.filter((field) => /^(?:part\s*)?[A-F](?:\d+)?\s*:?$|^(?:time|tank|status|check|code)$/i.test(field.label)).length }));
});
