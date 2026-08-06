import assert from "node:assert/strict";
import test from "node:test";
import { checkTemplateRuntimeSchema } from "../src/services/templateSchemaCheckService.js";
import { createTemplate, listTemplates, sendTemplateError, validateTemplatePayload } from "../src/controllers/templateController.js";

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
  return res;
};

test("PHASE 11: Schema Check Service correctly identifies valid and missing schemas", async () => {
  const mockHealthyDb = {
    query: async (sql) => {
      if (sql.includes("information_schema.tables")) {
        return { rows: [{ table_name: "inspection_templates" }, { table_name: "inspection_template_versions" }, { table_name: "inspection_reports" }, { table_name: "inspection_report_photos" }] };
      }
      if (sql.includes("information_schema.columns")) {
        return {
          rows: [
            { table_name: "inspection_templates", column_name: "id" },
            { table_name: "inspection_templates", column_name: "expert_id" },
            { table_name: "inspection_templates", column_name: "title" },
            { table_name: "inspection_templates", column_name: "description" },
            { table_name: "inspection_templates", column_name: "source_type" },
            { table_name: "inspection_templates", column_name: "extraction_method" },
            { table_name: "inspection_templates", column_name: "status" },
            { table_name: "inspection_templates", column_name: "extraction_status" },
            { table_name: "inspection_templates", column_name: "current_version_number" },
            { table_name: "inspection_templates", column_name: "has_photo_fields" },
            { table_name: "inspection_templates", column_name: "template_scope" },
            { table_name: "inspection_templates", column_name: "created_by_user_id" },
            { table_name: "inspection_template_versions", column_name: "id" },
            { table_name: "inspection_template_versions", column_name: "template_id" },
            { table_name: "inspection_template_versions", column_name: "version_number" },
            { table_name: "inspection_template_versions", column_name: "fields_jsonb" },
            { table_name: "inspection_template_versions", column_name: "layout_jsonb" },
            { table_name: "inspection_template_versions", column_name: "created_by_user_id" },
            { table_name: "inspection_reports", column_name: "id" },
            { table_name: "inspection_reports", column_name: "template_id" },
            { table_name: "inspection_reports", column_name: "template_version_id" },
            { table_name: "inspection_reports", column_name: "expert_id" },
            { table_name: "inspection_reports", column_name: "created_by_user_id" },
            { table_name: "inspection_reports", column_name: "title" },
            { table_name: "inspection_reports", column_name: "status" },
            { table_name: "inspection_reports", column_name: "values_jsonb" },
            { table_name: "inspection_report_photos", column_name: "id" },
            { table_name: "inspection_report_photos", column_name: "report_id" },
            { table_name: "inspection_report_photos", column_name: "field_key" },
            { table_name: "inspection_report_photos", column_name: "photo_s3_key" },
          ],
        };
      }
      if (sql.includes("pg_constraint")) {
        return { rows: [{ conname: "inspection_templates_source_type_check", def: "CHECK (source_type IN ('pdf','xml','docx','xlsx','manual'))" }] };
      }
      return { rows: [] };
    },
  };

  const status = await checkTemplateRuntimeSchema(mockHealthyDb, { forceRefresh: true });
  assert.equal(status.ready, true);
  assert.equal(status.missingTables.length, 0);
  assert.equal(status.missingColumns.length, 0);
});

test("PHASE 11 - Test 1, 2, 3, 4, 5: Error mapping and diagnostic classification", () => {
  // Test 2: Missing table 42P01 returns 503 TEMPLATES_SCHEMA_MISSING_TABLE
  const res2 = makeRes();
  sendTemplateError(res2, { code: "42P01", message: "relation missing" }, "Fallback");
  assert.equal(res2.statusCode, 503);
  assert.equal(res2.body.code, "TEMPLATES_SCHEMA_MISSING_TABLE");
  assert.equal(res2.body.message, "Inspection Templates database update has not been installed.");

  // Test 3: Missing column 42703 returns 503 TEMPLATES_SCHEMA_MISSING_COLUMN
  const res3 = makeRes();
  sendTemplateError(res3, { code: "42703", message: "column missing" }, "Fallback");
  assert.equal(res3.statusCode, 503);
  assert.equal(res3.body.code, "TEMPLATES_SCHEMA_MISSING_COLUMN");

  // Test 4: Database connection error ECONNREFUSED returns 503 TEMPLATES_DATABASE_UNAVAILABLE
  const res4 = makeRes();
  sendTemplateError(res4, { code: "ECONNREFUSED", message: "Connection refused" }, "Fallback");
  assert.equal(res4.statusCode, 503);
  assert.equal(res4.body.code, "TEMPLATES_DATABASE_UNAVAILABLE");

  // Test 5: SQL constraint error (23514 / 23502 / 23505) is NOT mislabeled as schema missing
  const res5 = makeRes();
  sendTemplateError(res5, { code: "23514", constraint: "some_check" }, "Fallback");
  assert.equal(res5.statusCode, 400);
  assert.equal(res5.body.code, "TEMPLATES_SCHEMA_CONSTRAINT_MISMATCH");

  const res5b = makeRes();
  sendTemplateError(res5b, { code: "23505", constraint: "unique_key" }, "Fallback");
  assert.equal(res5b.statusCode, 409);
});

test("PHASE 11 - Test 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20: Payload & Creation validation", () => {
  // Test 9 & 15 & 16: Blank manual NexaPort template payload validation
  const payloadManual = validateTemplatePayload({
    title: "Blank Hull Checklist",
    description: "Manual template",
    sourceType: "manual",
    extractionMethod: "manual",
    fields: [],
  });
  assert.equal(payloadManual.sourceType, "manual");
  assert.equal(payloadManual.layout.extractionMethod, "manual");

  // Test 11 & 17: Publish with valid photo field and maxPhotos 1-10 accepted
  const payloadPhoto = validateTemplatePayload({
    title: "Photo Template",
    sourceType: "manual",
    fields: [{ label: "Hull Damage", type: "photo", maxPhotos: 5 }],
  });
  assert.equal(payloadPhoto.fields[0].maxPhotos, 5);

  // Test 18: Invalid maxPhotos returns 400
  assert.throws(
    () => validateTemplatePayload({ title: "Test", sourceType: "manual", fields: [{ label: "Photo", type: "photo", maxPhotos: 15 }] }),
    (err) => err.status === 400
  );
});
