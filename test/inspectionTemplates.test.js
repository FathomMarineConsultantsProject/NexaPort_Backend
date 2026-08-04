import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import app, { allowedCorsOrigins, corsOptions, normalizeCorsOrigin } from "../src/app.js";
import { pool } from "../src/config/db.js";
import { missingRequiredFields, normalizeFields, validateReportValues } from "../src/services/templateFieldService.js";
import { createTemplate, listTemplates, sendTemplateError, templatePermissions, validateTemplatePayload } from "../src/controllers/templateController.js";
import { listReports } from "../src/controllers/reportController.js";
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
test("template creation rejects malformed coordinates", () => assert.throws(() => validateTemplatePayload({ ...payload, fields: [{ label: "Location", sourceCoordinates: { x: 0, y: 0, width: -1, height: 20 } }] }), /invalid source coordinates/));
test("template creation rejects malformed layout metadata", () => { assert.throws(() => validateTemplatePayload({ ...payload, extractionMethod: "remote" }), /Extraction method/); assert.throws(() => validateTemplatePayload({ ...payload, layout: { pageCount: 999 } }), /page count/); });
test("creation insert omits source-file storage columns", async () => { const text = await source("../src/controllers/templateController.js"); const insert = text.match(/INSERT INTO inspection_templates \(expert_id,template_scope[\s\S]*?RETURNING \*/)?.[0] || ""; assert.doesNotMatch(insert, /source_s3_key|source_file_name|source_mime_type|source_file_size/); });
test("template API has no source upload download or extraction routes", async () => { const text = await source("../src/routes/templateRoutes.js"); assert.doesNotMatch(text, /upload-url|source-url|\/extract/); });
test("template responses omit legacy source metadata", async () => { const text = await source("../src/controllers/templateController.js"); assert.match(text, /source_s3_key, source_file_name, source_mime_type, source_file_size/); });
test("shared template duplication copies JSON but no source object", async () => { const text = await source("../src/controllers/templateController.js"); assert.match(text, /sourceVersion\.fields_jsonb/); assert.doesNotMatch(text, /writePrivateObject|copiedKey/); });
test("template versions are inserted and never updated", async () => { const text = await source("../src/controllers/templateController.js"); assert.match(text, /INSERT INTO inspection_template_versions/); assert.doesNotMatch(text, /UPDATE inspection_template_versions/); });
test("report generation does not read a template source", async () => { const text = await source("../src/controllers/reportController.js"); assert.doesNotMatch(text, /source_s3_key|sourceBytes/); });
test("report photo uploads remain active", async () => assert.match(await source("../src/controllers/reportController.js"), /createPhotoUploadUrl[\s\S]*createPresignedPutUrl/));
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
test("OpenRouter key remains backend-only", async () => { const frontend = await source("../../NexaPort_Frontend/src/api/templateApi.js"); assert.doesNotMatch(frontend, /OPENROUTER_API_KEY|Bearer/); });

const mappingEvidence = { documentTitle: "Dock", sourceType: "pdf", pagesOrSheets: [{ name: "Page 1", lines: [{ text: "Decking in good condition? Yes No" }, { text: "____" }, { text: "Yes" }, { text: "popprobe.com" }, { text: "Decking in good condition? Yes No" }] }] };
const mappedOutput = { sections: [{ sectionKey: "dock", title: "Dock", sortOrder: 1 }], fields: [{ fieldKey: "decking_good", label: "Decking in good condition?", fieldType: "yes_no", required: false, sectionKey: "dock", sortOrder: 1, options: ["Yes", "No"], sourceText: "Decking in good condition? Yes No" }] };
const mappingEnv = { OPENROUTER_API_KEY: "test", OPENROUTER_TEMPLATE_MODEL: "test/model" };

test("mapping sends clean evidence in exactly one strict ZDR request", async () => { let calls = 0; let requestBody; const fetchImpl = async (_url, options) => { calls += 1; requestBody = JSON.parse(options.body); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(mappedOutput) } }] }) }; }; const result = await mapFieldsWithOpenRouter(mappingEvidence, { fetchImpl, env: mappingEnv }); const sent = JSON.parse(requestBody.messages[1].content); assert.equal(calls, 1); assert.equal(result.fields.length, 1); assert.deepEqual(sent.pagesOrSheets[0].lines.map((line) => line.text), ["Decking in good condition? Yes No"]); assert.equal(requestBody.response_format.type, "json_schema"); assert.equal(requestBody.response_format.json_schema.strict, true); assert.deepEqual(requestBody.provider, { require_parameters: true, zdr: true }); assert.equal(requestBody.max_tokens, 1600); assert.equal(requestBody.temperature, 0); });
test("invalid structured output is rejected without retry", async () => { let calls = 0; await assert.rejects(() => mapFieldsWithOpenRouter(mappingEvidence, { fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) }; }, env: mappingEnv }), /unsupported structured output/); assert.equal(calls, 1); });
for (const status of [402, 429]) test(`OpenRouter ${status} is not retried`, async () => { let calls = 0; await assert.rejects(() => mapFieldsWithOpenRouter(mappingEvidence, { fetchImpl: async () => { calls += 1; return { ok: false, status }; }, env: mappingEnv })); assert.equal(calls, 1); });
test("source bytes are rejected before OpenRouter is called", async () => { let calls = 0; assert.throws(() => normalizeMappingEvidence({ ...mappingEvidence, bytes: [1, 2] }), /bytes and files/); await assert.rejects(() => mapFieldsWithOpenRouter({ ...mappingEvidence, base64: "AA==" }, { fetchImpl: async () => { calls += 1; }, env: { OPENROUTER_API_KEY: "test" } }), /bytes and files/); assert.equal(calls, 0); });

const fixtureResult = async (sectionTitles, fieldSources) => {
  const sections = sectionTitles.map((title, index) => ({ sectionKey: `section_${index + 1}`, title, sortOrder: index + 1 }));
  const fields = fieldSources.map(({ sectionIndex, source, type = "yes_no", options = ["Yes", "No"] }, index) => ({ fieldKey: `field_${index + 1}`, label: source.replace(/\s*\*.*$/, "").replace(/\s+(?:Yes No|Good Fair Poor|Acceptable Unacceptable)$/, ""), fieldType: type, required: source.includes("*"), sectionKey: `section_${sectionIndex + 1}`, sortOrder: index + 1, options, sourceText: source }));
  const evidence = { documentTitle: "Fixture", sourceType: "pdf", pagesOrSheets: [{ name: "Page 1", lines: [...sectionTitles.map((text) => ({ text, bold: true })), ...fieldSources.map(({ source }) => ({ text: source }))] }] };
  return mapFieldsWithOpenRouter(evidence, { env: mappingEnv, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ sections, fields }) } }] }) }) });
};

test("Marina fixture validates ten sections and thirty fields", async () => { const sections = ["Inspection Information", "Dock Structure", "Electrical", "Fire Safety", "Safety Assessment", "Equipment Verification", "Environmental & Housekeeping", "Compliance Verification", "Communication & Prevention", "Summary & Sign-Off"]; const fields = Array.from({ length: 30 }, (_, index) => ({ sectionIndex: Math.min(9, Math.floor(index / 3)), source: index === 0 ? "Marina Name *" : index === 1 ? "Date *" : index === 29 ? "Inspector Signature *" : `Inspection item ${index + 1}? Yes No`, type: index === 0 ? "text" : index === 1 ? "date" : index === 29 ? "signature" : "yes_no", options: [0, 1, 29].includes(index) ? [] : ["Yes", "No"] })); const result = await fixtureResult(sections, fields); assert.equal(result.sections.length, 10); assert.equal(result.fields.length, 30); assert.equal(result.fields[1].label, "Date"); assert.equal(result.fields[1].required, true); });
test("USCG fixture validates three sections and ten fields", async () => { const sections = ["Structural Integrity", "Safety Protocols", "Emergency Equipment"]; const names = ["Hull condition Good Fair Poor", "Deck condition Good Fair Poor", "Superstructure condition Good Fair Poor", "Stability and freeboard Acceptable Unacceptable", "Life jackets available and functional Yes No", "Fire extinguishers serviced and charged Yes No", "Safety signage and markings clear Yes No", "EPIRB tested Yes No", "Flares and signals in date and functional Yes No", "Dewatering pumps and bilge alarms operational Yes No"]; const fields = names.map((source, index) => ({ sectionIndex: index < 4 ? 0 : index < 7 ? 1 : 2, source, type: index < 4 ? "select" : "yes_no", options: index < 3 ? ["Good", "Fair", "Poor"] : index === 3 ? ["Acceptable", "Unacceptable"] : ["Yes", "No"] })); const result = await fixtureResult(sections, fields); assert.equal(result.sections.length, 3); assert.equal(result.fields.length, 10); });
test("junk labels and duplicate normalized labels are rejected", async () => { for (const label of ["____", "Yes", "***", "???"]) await assert.rejects(() => mapFieldsWithOpenRouter(mappingEvidence, { env: mappingEnv, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ sections: mappedOutput.sections, fields: [{ ...mappedOutput.fields[0], label }] }) } }] }) }) })); const duplicate = { sections: mappedOutput.sections, fields: [mappedOutput.fields[0], { ...mappedOutput.fields[0], fieldKey: "duplicate" }] }; await assert.rejects(() => mapFieldsWithOpenRouter(mappingEvidence, { env: mappingEnv, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(duplicate) } }] }) }) }), /invalid or unsupported fields/); });
test("missing key and model return safe configuration errors", async () => { await assert.rejects(() => mapFieldsWithOpenRouter(mappingEvidence, { env: { OPENROUTER_TEMPLATE_MODEL: "test/model" } }), /API key is missing/); await assert.rejects(() => mapFieldsWithOpenRouter(mappingEvidence, { env: { OPENROUTER_API_KEY: "test" } }), /model is missing/); });
test("malformed JSON returns a safe error and document contents are not logged", async () => { const original = console.error; const logged = []; console.error = (...args) => logged.push(args); try { await assert.rejects(() => mapFieldsWithOpenRouter(mappingEvidence, { env: mappingEnv, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "{" } }] }) }) }), /malformed JSON/); assert.deepEqual(logged, []); } finally { console.error = original; } });
