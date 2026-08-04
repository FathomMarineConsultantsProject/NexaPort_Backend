import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import app, { allowedCorsOrigins, corsOptions, normalizeCorsOrigin } from "../src/app.js";
import { missingRequiredFields, normalizeFields, validateReportValues } from "../src/services/templateFieldService.js";
import { templatePermissions, validateTemplatePayload } from "../src/controllers/templateController.js";

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
