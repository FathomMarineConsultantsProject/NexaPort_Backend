import assert from "node:assert/strict";
import test from "node:test";
import { analyseTemplateObject, createTemplateAnalysisUpload } from "../src/controllers/templateController.js";
import { groupTemplateCandidates, runTemplateExtraction } from "../src/services/templateExtractionService.js";

const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test("large documents are grouped into a few logical calls rather than one call per field", () => {
  const candidates = Array.from({ length: 145 }, (_, index) => ({ id: `candidate-${index}`, section: index < 70 ? "Deck" : "Engine", sectionKey: index < 70 ? "deck" : "engine", context: [], metadata: { location: { pageNumber: Math.floor(index / 30) + 1 } } }));
  const docx = groupTemplateCandidates(candidates, "docx"); const pdf = groupTemplateCandidates(candidates, "pdf");
  assert.ok(docx.length >= 3 && docx.length <= 5); assert.ok(pdf.length >= 3 && pdf.length <= 5); assert.equal(docx.flatMap((chunk) => chunk.candidates).length, 145); assert.equal(pdf.flatMap((chunk) => chunk.candidates).length, 145);
  assert.ok(docx.every((chunk) => chunk.candidates.length <= 60)); assert.ok(pdf.every((chunk) => chunk.candidates.length <= 60));
});

test("medium documents use grouped DeepSeek calls with no silent candidate truncation", async () => {
  const blocks = [{ id: "block-0", globalOrder: 0, type: "heading", text: "READINGS", metadata: {}, location: {} }, ...Array.from({ length: 85 }, (_, index) => ({ id: `block-${index + 1}`, globalOrder: index + 1, type: "paragraph", text: `Tank Pressure ${index + 1}: ______`, metadata: {}, location: {} }))];
  const document = { fileName: "large.docx", fileType: "docx", extractionMethod: "text", parser: { package: "fixture" }, warnings: [], blocks, sections: [], headings: [], paragraphs: [], rows: [], cells: [], lists: [] };
  let calls = 0; const result = await runTemplateExtraction({ buffer: Buffer.from("fixture"), originalname: "large.docx" }, { sourceType: "docx", parseDocument: async () => document, env: { OPENROUTER_API_KEY: "test" }, classifyCandidates: async (payload) => { calls += 1; return { attempts: 1, modelUsed: "deepseek/test", warnings: [], fields: payload.candidates.map((candidate) => ({ candidateId: candidate.id, include: true, label: candidate.suggestedLabel, fieldType: candidate.suggestedType, section: "Readings", order: candidate.order, required: false, options: [] })) }; } });
  assert.equal(calls, 2); assert.equal(result.fields.length, 85); assert.equal(result.diagnostics.chunkCount, 2); assert.equal(result.diagnostics.qualityGate, true);
});

test("oversized source uploads use user-scoped temporary S3 objects and delete after analysis", async () => {
  const names = ["AWS_REGION", "AWS_S3_BUCKET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]; const saved = Object.fromEntries(names.map((name) => [name, process.env[name]])); Object.assign(process.env, { AWS_REGION: "ap-south-1", AWS_S3_BUCKET: "fixture-bucket", AWS_ACCESS_KEY_ID: "AKIATEST", AWS_SECRET_ACCESS_KEY: "test-secret" });
  const uploadRes = response(); await createTemplateAnalysisUpload({ user: { id: 42 }, body: { sourceType: "xml", contentType: "application/xml", size: 5 * 1024 * 1024 }, once() {} }, uploadRes);
  assert.equal(uploadRes.statusCode, 200); assert.match(uploadRes.body.data.objectKey, /^temporary\/template-analysis\/42\/[a-f0-9-]+\.xml$/); assert.match(uploadRes.body.data.uploadUrl, /^https:\/\/fixture-bucket\.s3\.ap-south-1\.amazonaws\.com\//); assert.doesNotMatch(uploadRes.body.data.uploadUrl, /test-secret/);
  const originalFetch = globalThis.fetch; const methods = []; const xml = Buffer.from("<root><vessel><vesselName/><inspectionDate/><remarks/></vessel></root>");
  globalThis.fetch = async (_url, options = {}) => { methods.push(options.method || "GET"); return options.method === "DELETE" ? new Response(null, { status: 204 }) : new Response(xml, { status: 200, headers: { "content-length": String(xml.length) } }); };
  try {
    const analysisRes = response(); await analyseTemplateObject({ user: { id: 42 }, body: { sourceType: "xml", objectKey: uploadRes.body.data.objectKey, fileName: "oversized.xml", contentType: "application/xml", size: 5 * 1024 * 1024 }, once() {} }, analysisRes);
    assert.equal(analysisRes.statusCode, 200); assert.ok(analysisRes.body.data.fields.length > 0); assert.deepEqual(methods, ["GET", "DELETE"]);
  } finally { globalThis.fetch = originalFetch; for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
});
