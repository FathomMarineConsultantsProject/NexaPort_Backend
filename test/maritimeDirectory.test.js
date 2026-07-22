import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { allowRoles, requireAuth } from "../src/middlewares/authMiddleware.js";
import { createMaritimeEntity, listMaritimeEntities, validateMaritimePayload } from "../src/services/maritimeDirectoryService.js";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const source = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const validPayload = { company: { companyName: "Harbour Services", publicEmail: " INFO@EXAMPLE.COM ", website: "example.com" }, directoryTypes: ["supplier", "ship_agent"], services: [{ serviceName: "Stores" }], ports: [], branches: [], certifications: [], classApprovals: [], memberships: [], products: [], faqs: [] };

test("maritime directory rejects unauthenticated, Consultant, and Client access", async () => {
  const unauthenticated = response();
  await requireAuth({ headers: {} }, unauthenticated, () => assert.fail("must not admit"));
  assert.equal(unauthenticated.statusCode, 401);
  for (const roleId of [2, 3]) {
    const denied = response(); let admitted = false;
    allowRoles(1)({ user: { role_id: roleId } }, denied, () => { admitted = true; });
    assert.equal(denied.statusCode, 403); assert.equal(admitted, false);
  }
  let admitted = false; allowRoles(1)({ user: { role_id: 1 } }, response(), () => { admitted = true; }); assert.equal(admitted, true);
});

test("routes apply Super Admin authorization to the entire module", async () => {
  const [routes, app] = await Promise.all([source("src/routes/maritimeDirectoryRoutes.js"), source("src/app.js")]);
  assert.match(routes, /router\.use\(requireAuth, allowRoles\(1\)\)/);
  assert.match(app, /app\.use\("\/api\/admin\/maritime-directory", maritimeDirectoryRoutes\)/);
});

test("type allowlist rejects unknown values and permits multiple supported types", () => {
  assert.throws(() => validateMaritimePayload({ ...validPayload, directoryTypes: ["invented"] }), (error) => Boolean(error.fieldErrors["directoryTypes.0"]));
  assert.deepEqual(validateMaritimePayload(validPayload).directoryTypes, ["supplier", "ship_agent"]);
});

test("manual create is transactional, approved, source controlled, and creates children", async () => {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/SELECT 1 FROM public\.maritime_directory_entities/.test(sql)) return { rows: [] };
    if (/INSERT INTO public\.maritime_directory_entities/.test(sql)) return { rows: [{ id: ID }] };
    if (/SELECT \* FROM public\.maritime_directory_entities/.test(sql)) return { rows: [{ id: ID, company_name: "Harbour Services", data_source: "manual_admin", review_status: "approved" }] };
    if (/SELECT directory_type/.test(sql)) return { rows: [{ directory_type: "ship_agent" }, { directory_type: "supplier" }] };
    return { rows: [] };
  };
  const database = { connect: async () => ({ query, release() {} }), query };
  const created = await createMaritimeEntity(validPayload, 9, database);
    assert.equal(created.entity.data_source, "manual_admin"); assert.equal(created.entity.review_status, "approved");
    assert.deepEqual(created.directory_types, ["ship_agent", "supplier"]);
    assert.ok(calls.some(({ sql }) => sql === "BEGIN")); assert.ok(calls.some(({ sql }) => sql === "COMMIT"));
    const entityInsert = calls.find(({ sql }) => /INSERT INTO public\.maritime_directory_entities/.test(sql));
    assert.match(entityInsert.sql, /'manual_admin','approved'/); assert.equal(entityInsert.params.at(-1), 9);
    assert.ok(calls.some(({ sql }) => /INSERT INTO public\.maritime_directory_services/.test(sql)));
});

test("a child database failure rolls back the whole create", async () => {
  const calls = [];
  const query = async (sql) => {
    calls.push(sql);
    if (/SELECT 1 FROM/.test(sql)) return { rows: [] };
    if (/INSERT INTO public\.maritime_directory_entities/.test(sql)) return { rows: [{ id: ID }] };
    if (/INSERT INTO public\.maritime_directory_services/.test(sql)) throw new Error("child failed");
    return { rows: [] };
  };
  const database = { connect: async () => ({ query, release() {} }), query };
  await assert.rejects(createMaritimeEntity(validPayload, 9, database), /child failed/); assert.ok(calls.includes("ROLLBACK")); assert.ok(!calls.includes("COMMIT"));
});

test("list uses server pagination and returns pending imports by default", async () => {
  const calls = [];
  const queryable = { query: async (sql, params) => { calls.push({ sql, params }); return /COUNT\(\*\)/.test(sql) && !/service_count/.test(sql) ? { rows: [{ total: 1 }] } : { rows: [{ id: ID, review_status: "pending", data_source: "magicport_public_directory" }] }; } };
  const result = await listMaritimeEntities({ type: "supplier", page: "1", limit: "20" }, queryable);
    assert.equal(result.pagination.total, 1); assert.equal(result.data[0].review_status, "pending");
    assert.ok(calls.every(({ sql }) => !/review_status=/.test(sql)));
    assert.deepEqual(calls.at(-1).params.slice(-2), [20, 0]);
});

test("list search is parameterized and fixed-table only", async () => {
  const calls = [];
  const queryable = { query: async (sql, params) => { calls.push({ sql, params }); return /SELECT COUNT/.test(sql) ? { rows: [{ total: 0 }] } : { rows: [] }; } };
  await listMaritimeEntities({ type: "supplier", search: "%' OR 1=1 --" }, queryable); assert.ok(calls.every(({ sql }) => !sql.includes("OR 1=1"))); assert.equal(calls[0].params[1], "%' OR 1=1 --");
});

test("controller exposes stable error fields rather than database implementation fields", async () => {
  const controller = await source("src/controllers/maritimeDirectoryController.js");
  assert.match(controller, /MARITIME_DIRECTORY_REQUEST_FAILED/);
  assert.match(controller, /status >= 500 \? "The directory request could not be completed\."/);
  assert.doesNotMatch(controller, /error\.stack|error\.detail|error\.constraint|error\.query/);
});

test("normal updates cannot overwrite imported provenance", async () => {
  const service = await source("src/services/maritimeDirectoryService.js");
  const updateBlock = service.slice(service.indexOf("export const updateMaritimeEntity"), service.indexOf("export const setMaritimeEntityState"));
  assert.doesNotMatch(updateBlock, /source_key|source_provider_id|source_url|scraped_at|content_checksum|data_source|created_by_user_id/);
});

test("migrations preserve staging, normalize children, and map every supported evidence type", async () => {
  const [schema, mapping] = await Promise.all([source("../Maritime_Directory_Migration/001_maritime_directory_schema.sql"), source("../Maritime_Directory_Migration/002_map_imported_provider_data.sql")]);
  for (const table of ["entities", "entity_types", "services", "ports", "branches", "certifications", "class_approvals", "memberships", "products", "faqs"]) assert.match(schema, new RegExp(`maritime_directory_${table}`));
  assert.match(schema, /ON DELETE CASCADE/g); assert.doesNotMatch(mapping, /DROP TABLE|TRUNCATE|DELETE FROM public\.imported/);
  for (const type of ["service_provider", "ship_agent", "supplier", "shipyard", "tug_boat"]) assert.match(mapping, new RegExp(type));
  assert.match(mapping, /ON CONFLICT \(entity_id, source_record_key\) WHERE source_record_key IS NOT NULL/);
});
