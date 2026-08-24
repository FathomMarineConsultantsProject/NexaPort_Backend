import assert from "node:assert/strict";
import test from "node:test";
import { buildInspectorSearchQuery, normalizeInspectorSearch, searchInspectors } from "../src/services/inspectorDirectoryService.js";

test("federated inspector query searches all four real sources without exposing consultant registration secrets", () => {
  const { sql } = buildInspectorSearchQuery({ q: "Singapore" });
  for (const source of ["experts e", "flag_inspectors fi", "accredited_inspectors ai", "appointed_ship_surveyors aps"]) assert.match(sql, new RegExp(source));
  assert.match(sql, /erd\.photo_s3_key/);
  assert.doesNotMatch(sql, /cv_s3_key|phone_number|date_of_birth|refs|street1|postal_code|user_email/);
});

test("country/location and flag state use separate predicates and parameters", () => {
  const { sql, values } = buildInspectorSearchQuery({ country: "Singapore", flagState: "Panama" });
  assert.match(sql, /country_location/);
  assert.match(sql, /COALESCE\(flag_state,''\) ILIKE/);
  assert.equal(values[2], "%Singapore%");
  assert.equal(values[5], "Panama");
});

test("type validation and pagination are bounded", () => {
  assert.throws(() => normalizeInspectorSearch({ type: "private_documents" }), /Unsupported inspector type/);
  assert.deepEqual(normalizeInspectorSearch({ type: "flag_inspector", page: 3, limit: 500 }), {
    q: "", country: "", type: "flag_inspector", discipline: "", flagState: "", page: 3, limit: 100,
  });
});

test("combined result preserves source/type labels and pagination", async () => {
  const rows = [
    { source_id: "1", inspector_type: "nexaport_consultant", name: "Consultant SG", source_name: "Nexaport", image_key: null, total: 4, relevance: 0 },
    { source_id: "2", inspector_type: "flag_inspector", name: "Flag SG", source_name: "Flag Directory", image_key: null, total: 4, relevance: 0 },
    { source_id: "3", inspector_type: "accredited_inspector", name: "Accredited SG", source_name: "Accreditation Directory", image_key: null, total: 4, relevance: 0 },
    { source_id: "4", inspector_type: "appointed_surveyor", name: "Appointed SG", source_name: "Appointment Directory", image_key: null, total: 4, relevance: 0 },
  ];
  const result = await searchInspectors({ query: async () => ({ rows }) }, { q: "Singapore", page: 1, limit: 2 });
  assert.equal(result.total, 4);
  assert.equal(result.totalPages, 2);
  assert.deepEqual(result.items.map((item) => item.inspector_type), ["nexaport_consultant", "flag_inspector", "accredited_inspector", "appointed_surveyor"]);
  assert.ok(result.items.every((item) => !("image_key" in item) && !("total" in item)));
});
