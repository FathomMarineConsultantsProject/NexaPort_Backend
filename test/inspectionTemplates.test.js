import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import { PDFDocument, PDFName } from "pdf-lib";
import app, { allowedCorsOrigins, corsOptions, normalizeCorsOrigin } from "../src/app.js";
import { pool } from "../src/config/db.js";
import { missingRequiredFields, normalizeFields, sanitizeFieldSourceMetadata, validateReportValues } from "../src/services/templateFieldService.js";
import { createTemplate, listTemplates, sendTemplateError, templatePermissions, validateTemplatePayload } from "../src/controllers/templateController.js";
import { listReports, normalizeLocalMedia } from "../src/controllers/reportController.js";
import { generateReportPdf } from "../src/services/pdfGenerationService.js";
import { createPhase1PdfFixture } from "./generatePhase1PdfFixture.js";
import { mapFieldsWithOpenRouter, normalizeMappingEvidence } from "../src/services/openRouterTemplateService.js";

const source = async (file) => readFile(new URL(file, import.meta.url), "utf8");
const payload = { title: "Checklist", sourceType: "pdf", extractionMethod: "text", fields: [{ fieldKey: "vessel_name", label: "Vessel Name", fieldType: "text", required: false, section: "Vessel", sortOrder: 0 }] };
const corsAllowed = (origin) => new Promise((resolve, reject) => corsOptions.origin(origin, (error, allowed) => error ? reject(error) : resolve(allowed)));
const productionOrigin = "https://nexa-port-frontend.vercel.app";
let server;
let baseUrl;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const preflight = (path, method = "GET") => fetch(`${baseUrl}${path}`, {
  method: "OPTIONS",
  headers: {
    Origin: productionOrigin,
    "Access-Control-Request-Method": method,
    "Access-Control-Request-Headers": "authorization,content-type",
  },
});

test("role 3 cannot access Templates", async () => assert.match(await source("../src/routes/templateRoutes.js"), /allowRoles\(1, 2\)/));
test("role 1-created template has nexaport scope and no expert owner", async () => { const text = await source("../src/controllers/templateController.js"); assert.match(text, /roleId === 1 \? "nexaport" : "private"/); assert.match(text, /roleId === 2 \? await expertIdForUser\(client, req\.user\.id\) : null/); });
test("role 2-created template has private ownership", () => assert.equal(templatePermissions({ template_scope: "private", expert_id: 7, status: "published", current_version_number: 1 }, 2, 7).canEdit, true));
test("role 1 cannot edit consultant private templates", () => assert.equal(templatePermissions({ template_scope: "private", expert_id: 7, status: "published", current_version_number: 1 }, 1).canEdit, false));
test("role 2 cannot edit NexaPort templates", () => assert.equal(templatePermissions({ template_scope: "nexaport", expert_id: null, status: "published", current_version_number: 1 }, 2, 7).canEdit, false));
test("consultants only use published NexaPort templates", () => { assert.equal(templatePermissions({ template_scope: "nexaport", status: "published", current_version_number: 1 }, 2, 7).canUse, true); assert.equal(templatePermissions({ template_scope: "nexaport", status: "draft", current_version_number: 1 }, 2, 7).canUse, false); });
test("template creation accepts normalized fields without source storage", () => { const result = validateTemplatePayload(payload); assert.equal(result.fields[0].type, "text"); assert.equal(result.sourceType, "pdf"); });
test("template creation rejects raw file content", () => { for (const extra of [{ bytes: [1, 2] }, { base64: "JVBER" }, { sourceData: "data:application/pdf;base64,JVBER" }, { layout: { file: "%PDF-1.7" } }]) assert.throws(() => validateTemplatePayload({ ...payload, ...extra }), /not accepted/); });
test("template creation rejects unsupported field types", () => assert.throws(() => validateTemplatePayload({ ...payload, fields: [{ label: "Danger", type: "script" }] }), /unsupported type/));
test("template creation strips malformed optional coordinates", () => { const normalized = validateTemplatePayload({ ...payload, sourceType: "docx", fields: [{ label: "Location", sourceCoordinates: { x: 0, y: 0, width: -1, height: 20 } }] }); assert.equal(normalized.fields[0].sourceCoordinates, null); });
test("source metadata is format-specific and non-blocking", () => { assert.deepEqual(sanitizeFieldSourceMetadata({ sourceBounds: { x: 1, y: 2, width: 3, height: 4 } }, "pdf").sourceCoordinates, { x: 1, y: 2, width: 3, height: 4 }); assert.equal(sanitizeFieldSourceMetadata({ sourceBounds: { x: 1 } }, "pdf").sourceCoordinates, undefined); assert.equal(sanitizeFieldSourceMetadata({ sourceCoordinates: { x: 0, y: 0, width: NaN, height: 1 } }, "pdf").sourceCoordinates, undefined); assert.deepEqual(sanitizeFieldSourceMetadata({ tableIndex: 2, rowIndex: 4, columnIndex: 1 }, "docx"), { tableIndex: 2, rowIndex: 4, columnIndex: 1, sourceTableIndex: 2, sourceRow: 4, sourceColumn: 1 }); assert.equal(sanitizeFieldSourceMetadata({ sourceSheet: "Inspection", rowIndex: 14, columnIndex: 3 }, "xlsx").sourceSheet, "Inspection"); assert.equal(sanitizeFieldSourceMetadata({ sourceElementPath: "/inspection/field", sourceBlockOrder: 22 }, "xml").sourceElementPath, "/inspection/field"); });
test("user field errors are structured and cumulative", () => { assert.throws(() => normalizeFields([{ fieldKey: "same", label: "", type: "text" }, { fieldKey: "same", label: "Photo", type: "photo", maxPhotos: 11 }]), (error) => { assert.equal(error.fieldErrors.length, 2); assert.deepEqual(error.fieldErrors.map((item) => item.property), ["label", "maxPhotos"]); return true; }); });
test("template creation rejects malformed layout metadata", () => { assert.throws(() => validateTemplatePayload({ ...payload, extractionMethod: "remote" }), /Extraction method/); assert.throws(() => validateTemplatePayload({ ...payload, layout: { pageCount: 10001 } }), /page count/); });
test("creation insert omits source-file storage columns", async () => { const text = await source("../src/controllers/templateController.js"); const insert = text.match(/INSERT INTO inspection_templates \(expert_id,template_scope[\s\S]*?RETURNING \*/)?.[0] || ""; assert.doesNotMatch(insert, /source_s3_key|source_file_name|source_mime_type|source_file_size/); });
test("template API has no source upload download or extraction routes", async () => { const text = await source("../src/routes/templateRoutes.js"); assert.doesNotMatch(text, /upload-url|source-url|\/extract/); });
test("template responses omit legacy source metadata", async () => { const text = await source("../src/controllers/templateController.js"); assert.match(text, /source_s3_key, source_file_name, source_mime_type, source_file_size/); });
test("shared template duplication copies JSON but no source object", async () => { const text = await source("../src/controllers/templateController.js"); assert.match(text, /sourceVersion\.fields_jsonb/); assert.doesNotMatch(text, /writePrivateObject|copiedKey/); });
test("template versions are inserted and never updated", async () => { const text = await source("../src/controllers/templateController.js"); assert.match(text, /INSERT INTO inspection_template_versions/); assert.doesNotMatch(text, /UPDATE inspection_template_versions/); });
test("report generation does not read a template source", async () => { const text = await source("../src/controllers/reportController.js"); assert.doesNotMatch(text, /source_s3_key|sourceBytes/); });
test("report media is accepted only for one-time PDF generation", async () => { const controller = await source("../src/controllers/reportController.js"); const routes = await source("../src/routes/reportRoutes.js"); assert.doesNotMatch(controller + routes, /inspection_report_photos|photo-upload-url|createPresignedPutUrl/); assert.match(routes, /application\/vnd\.nexaport\.report\+json/); assert.match(controller, /normalizeLocalMedia/); });
test("one-time local media is validated and normalized in memory", async () => { const fields = normalizeFields([{ fieldKey: "photo_evidence", label: "Photo evidence", type: "photo", captionEnabled: true }]); const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="; const media = await normalizeLocalMedia(Buffer.from(JSON.stringify({ media: [{ fieldKey: "photo_evidence", mimeType: "image/png", dataUrl, caption: "Bow" }] })), fields); assert.equal(media[0].caption, "Bow"); assert.equal(media[0].mimeType, "image/png"); assert.ok(Buffer.isBuffer(media[0].bytes)); await assert.rejects(() => normalizeLocalMedia(Buffer.from(JSON.stringify({ media: [{ fieldKey: "unknown", mimeType: "image/png", dataUrl }] })), fields), /invalid/); });
test("the generated PDF embeds locally supplied image media", async () => { const fields = normalizeFields([{ fieldKey: "photo_evidence", label: "Photo evidence", type: "photo" }]); const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"); const output = await generateReportPdf({ title: "Media fixture", fields, values: {}, photos: [{ fieldKey: "photo_evidence", type: "photo", label: "Photo evidence", mimeType: "image/png", bytes }] }); const pdf = await PDFDocument.load(output); const images = [...pdf.context.enumerateIndirectObjects()].filter(([, object]) => object?.dict?.get(PDFName.of("Subtype"))?.toString() === "/Image"); assert.ok(pdf.getPageCount() >= 1); assert.equal(images.length, 1); assert.ok(output.length > 1000); });
test("phase 1 PDF fixture is multi-page and embeds both photos plus signature", async () => { const output = await createPhase1PdfFixture(); const pdf = await PDFDocument.load(output); const images = [...pdf.context.enumerateIndirectObjects()].filter(([, object]) => object?.dict?.get(PDFName.of("Subtype"))?.toString() === "/Image"); assert.ok(pdf.getPageCount() >= 4); assert.ok(images.length >= 3); });
test("PDF renderer uses anonymous identity, human dates, running headers and measured blocks", async () => { const sourceText = await source("../src/services/pdfGenerationService.js"); assert.match(sourceText, /NexaPort Inspector/); assert.match(sourceText, /toLocaleDateString/); assert.match(sourceText, /drawRunningHeader/); assert.match(sourceText, /widthOfTextAtSize/); assert.match(sourceText, /\(continued\)/); assert.doesNotMatch(sourceText, /consultant\?\.|full_name|toISOString/); });
test("generated report PDF private storage remains active", async () => { const text = await source("../src/controllers/reportController.js"); assert.match(text, /generated\/report-v/); assert.match(text, /writePrivateObject\(key, "application\/pdf"/); });
test("generated report download URLs remain temporary", async () => assert.match(await source("../src/controllers/reportController.js"), /expiresInSeconds: 300/));
test("deployed frontend and localhost CORS origins are allowed", async () => {
  assert.equal(await corsAllowed(productionOrigin), true);
  assert.equal(await corsAllowed("http://localhost:5173"), true);
  assert.equal(await corsAllowed("http://localhost:5174"), true);
});
test("configured CORS origins are trimmed and trailing slashes are removed", () => {
  assert.equal(normalizeCorsOrigin(`  ${productionOrigin}/  `), productionOrigin);
  assert.equal(allowedCorsOrigins.has(productionOrigin), true);
});
test("allowed preflights finish before route authentication", async () => {
  for (const [path, method] of [
    ["/api/auth/login", "POST"],
    ["/api/experts", "GET"],
    ["/api/flags/panama/directory", "GET"],
    ["/api/service-requests", "POST"],
    ["/api/notifications", "GET"],
    ["/api/templates", "GET"],
    ["/api/reports", "GET"],
  ]) {
    const response = await preflight(path, method);
    assert.equal(response.status, 204, path);
    assert.equal(response.headers.get("access-control-allow-origin"), productionOrigin, path);
    assert.equal(response.headers.get("access-control-allow-credentials"), "true", path);
    assert.match(response.headers.get("access-control-allow-headers") || "", /Authorization/i, path);
    assert.match(response.headers.get("access-control-allow-headers") || "", /Content-Type/i, path);
    assert.match(response.headers.get("access-control-allow-methods") || "", new RegExp(method, "i"), path);
  }
});
test("unknown origins receive no ACAO and requests without Origin remain usable", async () => {
  assert.equal(await corsAllowed("https://unknown.invalid"), false);
  const rejected = await fetch(`${baseUrl}/health`, { headers: { Origin: "https://unknown.invalid" } });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  const noOrigin = await fetch(`${baseUrl}/health`);
  assert.equal(noOrigin.status, 200);
  assert.deepEqual(await noOrigin.json(), { success: true, status: "OK" });
});
test("health remains available to the deployed frontend", async () => {
  const response = await fetch(`${baseUrl}/health`, { headers: { Origin: productionOrigin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), productionOrigin);
});
test("configured deployed origins remain supported", async () => assert.match(await source("../src/app.js"), /CORS_ALLOWED_ORIGINS/));
test("unknown report field keys are rejected", () => assert.throws(() => validateReportValues(normalizeFields([{ label: "Known" }]), { unknown: "x" }), /Unknown report field key/));
test("required photos and values remain validated", () => { const fields = normalizeFields([{ label: "Name", required: true }, { label: "Photo", type: "photo", required: true }]); assert.equal(missingRequiredFields(fields, {}, new Set()).length, 2); });
test("the standalone patch preserves columns and only drops NOT NULL", async () => { const sql = await source("../sql/inspection_templates_004_remove_source_persistence_requirement.sql"); assert.match(sql, /BEGIN;[\s\S]*DROP NOT NULL[\s\S]*COMMIT;/); assert.doesNotMatch(sql, /DROP COLUMN|DELETE FROM/); });
test("runtime alignment patch is transactional, rerun-safe and preserves records", async () => { const sql = await source("../sql/inspection_templates_005_align_runtime_schema.sql"); assert.match(sql, /BEGIN;[\s\S]*COMMIT;/); assert.match(sql, /ADD COLUMN IF NOT EXISTS template_scope/); assert.match(sql, /created_by_user_id/); assert.match(sql, /source_type IN \('pdf','xml','docx','xlsx'\)/); assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM/); });

const responseRecorder = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test("template and report lists use the aligned runtime schema without failing", async () => {
  const original = pool.query; pool.query = async () => ({ rows: [] });
  try { const templates = responseRecorder(); const reports = responseRecorder(); await listTemplates({ user: { id: 1, role_id: 1 } }, templates); await listReports({ user: { id: 1, role_id: 1 } }, reports); assert.equal(templates.body.success, true); assert.equal(reports.body.success, true); }
  finally { pool.query = original; }
});

for (const roleId of [1, 2]) test(`${roleId === 1 ? "Super Admin" : "Consultant"} template creation commits one transaction and releases the client`, async () => {
  const original = pool.connect; const calls = []; let released = false;
  const client = { query: async (sql) => { calls.push(sql); if (sql.startsWith("SELECT id FROM experts")) return { rows: [{ id: 9 }] }; if (sql.startsWith("INSERT INTO inspection_templates")) return { rows: [{ id: 12, expert_id: roleId === 2 ? 9 : null, template_scope: roleId === 1 ? "nexaport" : "private", status: roleId === 1 ? "draft" : "published", current_version_number: 1 }] }; if (sql.startsWith("INSERT INTO inspection_template_versions")) return { rows: [{ id: 20, version_number: 1 }] }; return { rows: [] }; }, release: () => { released = true; } };
  pool.connect = async () => client;
  try { const res = responseRecorder(); await createTemplate({ user: { id: 4, role_id: roleId }, body: payload }, res); assert.equal(res.statusCode, 201); assert.equal(calls.filter((sql) => sql === "BEGIN").length, 1); assert.equal(calls.filter((sql) => sql === "COMMIT").length, 1); assert.equal(released, true); }
  finally { pool.connect = original; }
});

test("missing runtime schema returns the operational update message", () => { const res = responseRecorder(); sendTemplateError(res, { code: "42703", column: "template_scope" }, "fallback"); assert.equal(res.statusCode, 503); assert.equal(res.body.message, "Inspection Templates database update has not been installed."); });
test("role 3 cannot map fields", async () => { const routes = await source("../src/routes/templateRoutes.js"); assert.match(routes, /router\.use\(requireAuth, allowRoles\(1, 2\)\)/); assert.match(routes, /post\("\/map-fields"/); });
test("provider API keys remain backend-only", async () => { const frontend = await source("../../NexaPort_Frontend/src/api/templateApi.js"); assert.doesNotMatch(frontend, /GEMINI_API_KEY|OPENROUTER_API_KEY|Bearer/); });

const mappingEvidence = { documentTitle: "Dock", sourceType: "pdf", pagesOrSheets: [{ name: "Page 1", lines: [{ text: "Decking in good condition? Yes No" }, { text: "____" }, { text: "Yes" }, { text: "popprobe.com" }, { text: "Decking in good condition? Yes No" }] }] };
const mappedOutput = { documentTitle: "Dock", sections: [{ sectionKey: "dock", title: "Dock", sourceOrder: 0, evidenceRefs: ["block-0"] }], fields: [{ fieldKey: "decking_good", label: "Decking in good condition?", fieldType: "yes_no", required: false, sectionKey: "dock", sourceOrder: 0, options: ["Yes", "No"], sourceText: "Decking in good condition? Yes No", evidenceRefs: ["block-0"], confidence: .95, warning: "" }], classifications: [{ blockId: "block-0", classification: "field", reason: "Question" }], notes: [], referenceData: [], warnings: [], unmappedBlocks: [] };
const mappingEnv = { OPENROUTER_API_KEY: "test", OPENROUTER_TEMPLATE_MODEL: "test/model" };

test("mapping sends bounded structured evidence in one ZDR schema request", async () => { let calls = 0; let requestBody; const fetchImpl = async (_url, options) => { calls += 1; requestBody = JSON.parse(options.body); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(mappedOutput) } }] }) }; }; const result = await mapFieldsWithOpenRouter(mappingEvidence, { fetchImpl, env: mappingEnv }); const sent = JSON.parse(requestBody.messages[1].content); assert.equal(calls, 1); assert.equal(result.fields.length, 1); assert.equal(sent.chunk.blocks[0].text, "Decking in good condition? Yes No"); assert.equal(requestBody.response_format.type, "json_schema"); assert.equal(requestBody.response_format.json_schema.name, "template_document_mapping"); assert.deepEqual(requestBody.provider, { require_parameters: true, zdr: true }); assert.deepEqual(requestBody.reasoning, { effort: "medium" }); assert.equal(requestBody.max_tokens, 8192); assert.equal(requestBody.temperature, 0); });
test("invalid structured output is rejected without retry", async () => { let calls = 0; await assert.rejects(() => mapFieldsWithOpenRouter(mappingEvidence, { fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) }; }, env: mappingEnv }), /unsupported structured output/); assert.equal(calls, 1); });
test("OpenRouter 402 is not retried", async () => { let calls = 0; await assert.rejects(() => mapFieldsWithOpenRouter(mappingEvidence, { fetchImpl: async () => { calls += 1; return { ok: false, status: 402 }; }, env: mappingEnv })); assert.equal(calls, 1); });
test("OpenRouter 429 is not retried because OpenRouter is already the fallback", async () => { let calls = 0; await assert.rejects(() => mapFieldsWithOpenRouter(mappingEvidence, { fetchImpl: async () => { calls += 1; return { ok: false, status: 429 }; }, env: mappingEnv })); assert.equal(calls, 1); });
test("source bytes are rejected before OpenRouter is called", async () => { let calls = 0; assert.throws(() => normalizeMappingEvidence({ ...mappingEvidence, bytes: [1, 2] }), /bytes and files/); await assert.rejects(() => mapFieldsWithOpenRouter({ ...mappingEvidence, base64: "AA==" }, { fetchImpl: async () => { calls += 1; }, env: { OPENROUTER_API_KEY: "test" } }), /bytes and files/); assert.equal(calls, 0); });

const fixtureResult = async (sectionTitles, fieldSources) => {
  const sectionCount = sectionTitles.length;
  const sections = sectionTitles.map((title, index) => ({ sectionKey: `section_${index + 1}`, title, sourceOrder: index, evidenceRefs: [`block-${index}`] }));
  const fields = fieldSources.map(({ sectionIndex, source, type = "yes_no", options = ["Yes", "No"] }, index) => ({ fieldKey: `field_${index + 1}`, label: source.replace(/\s*\*.*$/, "").replace(/\s+(?:Yes No|Good Fair Poor|Acceptable Unacceptable)$/, ""), fieldType: type, required: source.includes("*"), sectionKey: `section_${sectionIndex + 1}`, sourceOrder: sectionCount + index, options, sourceText: source, evidenceRefs: [`block-${sectionCount + index}`], confidence: .9, warning: "" }));
  const evidence = { documentTitle: "Fixture", sourceType: "pdf", pagesOrSheets: [{ name: "Page 1", lines: [...sectionTitles.map((text) => ({ text, bold: true })), ...fieldSources.map(({ source }) => ({ text: source }))] }] };
  const classifications = [...sections.map((section) => ({ blockId: section.evidenceRefs[0], classification: "section", reason: "Heading" })), ...fields.map((field) => ({ blockId: field.evidenceRefs[0], classification: "field", reason: "Input" }))];
  return mapFieldsWithOpenRouter(evidence, { env: mappingEnv, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ documentTitle: "Fixture", sections, fields, classifications, notes: [], referenceData: [], warnings: [], unmappedBlocks: [] }) } }] }) }) });
};

test("Marina fixture validates ten sections and thirty fields", async () => { const sections = ["Inspection Information", "Dock Structure", "Electrical", "Fire Safety", "Safety Assessment", "Equipment Verification", "Environmental & Housekeeping", "Compliance Verification", "Communication & Prevention", "Summary & Sign-Off"]; const fields = Array.from({ length: 30 }, (_, index) => ({ sectionIndex: Math.min(9, Math.floor(index / 3)), source: index === 0 ? "Marina Name *" : index === 1 ? "Date *" : index === 29 ? "Inspector Signature *" : `Inspection item ${index + 1}? Yes No`, type: index === 0 ? "text" : index === 1 ? "date" : index === 29 ? "signature" : "yes_no", options: [0, 1, 29].includes(index) ? [] : ["Yes", "No"] })); const result = await fixtureResult(sections, fields); assert.equal(result.sections.length, 10); assert.equal(result.fields.length, 30); assert.equal(result.fields[1].label, "Date"); assert.equal(result.fields[1].required, true); });
test("USCG fixture validates three sections and ten fields", async () => { const sections = ["Structural Integrity", "Safety Protocols", "Emergency Equipment"]; const names = ["Hull condition Good Fair Poor", "Deck condition Good Fair Poor", "Superstructure condition Good Fair Poor", "Stability and freeboard Acceptable Unacceptable", "Life jackets available and functional Yes No", "Fire extinguishers serviced and charged Yes No", "Safety signage and markings clear Yes No", "EPIRB tested Yes No", "Flares and signals in date and functional Yes No", "Dewatering pumps and bilge alarms operational Yes No"]; const fields = names.map((source, index) => ({ sectionIndex: index < 4 ? 0 : index < 7 ? 1 : 2, source, type: index < 4 ? "select" : "yes_no", options: index < 3 ? ["Good", "Fair", "Poor"] : index === 3 ? ["Acceptable", "Unacceptable"] : ["Yes", "No"] })); const result = await fixtureResult(sections, fields); assert.equal(result.sections.length, 3); assert.equal(result.fields.length, 10); });
test("an invalid field is dropped without destroying grounded fields", async () => { const output = { ...mappedOutput, fields: [mappedOutput.fields[0], { ...mappedOutput.fields[0], fieldKey: "invented", sourceText: "not present" }] }; const result = await mapFieldsWithOpenRouter(mappingEvidence, { env: mappingEnv, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }] }) }) }); assert.deepEqual(result.fields.map((field) => field.fieldKey), ["decking_good"]); });
test("missing key is rejected and the fallback model has a safe default", async () => { await assert.rejects(() => mapFieldsWithOpenRouter(mappingEvidence, { env: { OPENROUTER_TEMPLATE_MODEL: "test/model" } }), /API key is missing/); let requestBody; await mapFieldsWithOpenRouter(mappingEvidence, { env: { OPENROUTER_API_KEY: "test" }, fetchImpl: async (_url, options) => { requestBody = JSON.parse(options.body); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(mappedOutput) } }] }) }; } }); assert.equal(requestBody.model, "google/gemini-3.5-flash"); });
test("malformed JSON returns a safe error and document contents are not logged", async () => { const original = console.error; const logged = []; console.error = (...args) => logged.push(args); try { await assert.rejects(() => mapFieldsWithOpenRouter(mappingEvidence, { env: mappingEnv, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "{" } }] }) }) }), /malformed JSON/); assert.deepEqual(logged, []); } finally { console.error = original; } });
