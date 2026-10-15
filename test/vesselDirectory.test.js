import test from "node:test";
import assert from "node:assert/strict";
import { buildVesselDirectoryFilter, getVesselDirectoryDetail, listVesselDirectory, listVesselDirectoryFlags } from "../src/services/vesselDirectoryService.js";
import { VESSEL_DIRECTORY_ROLES } from "../src/routes/vesselDirectoryRoutes.js";
import { getVessels } from "../src/controllers/vesselController.js";
import { pool } from "../src/config/db.js";

test("directory policy is Super Admin only", () => assert.deepEqual(VESSEL_DIRECTORY_ROLES, [1]));

test("filters use parameters and bounded pagination", () => {
  const f = buildVesselDirectoryFilter({ search: "' OR true --", type: "tanker", flag: "Norway", dwtMin: "500", gtMax: "9000", page: "3", limit: "999", sort: "gt", direction: "desc" });
  assert.equal(f.limit, 100);
  assert.equal(f.offset, 200);
  assert.equal(f.values[0], "' OR true --");
  assert.match(f.where, /d\.gt <= \$5/);
  assert.equal(f.order, "d.gt DESC NULLS LAST, d.id ASC");
  assert.throws(() => buildVesselDirectoryFilter({ dwtMin: "-1" }), /nonnegative/);
});

test("listing and detail only query global directory tables", async () => {
  const sql = [];
  const db = { query: async (statement, values) => { sql.push([statement, values]); return { rows: statement.includes("COUNT(*)") ? [{ total: 1 }] : [{ id: 8, name: "Vessel" }] }; } };
  const listed = await listVesselDirectory({ page: 1 }, db);
  assert.equal(listed.pagination.total, 1);
  assert.equal(listed.vessels.length, 1);
  const detail = await getVesselDirectoryDetail("8", db);
  assert.equal(detail.id, 8);
  assert.equal(sql.length, 3);
  for (const [statement] of sql) {
    assert.doesNotMatch(statement, /client_onboarding|service_requests|quotations|created_by_user_id/i);
  }
  assert.match(sql[0][0], /LIMIT \$1 OFFSET \$2/);
  assert.deepEqual(sql[2][1], ["8"]);
  await assert.rejects(() => getVesselDirectoryDetail("8 OR 1=1", db), /Invalid vessel ID/);
});

test("flag suggestions query distinct global values with a fixed bound", async () => {
  let sql = "";
  const db = { query: async (statement) => { sql = statement; return { rows: [{ flag: "India" }, { flag: "Panama" }] }; } };
  assert.deepEqual(await listVesselDirectoryFlags(db), ["India", "Panama"]);
  assert.match(sql, /SELECT DISTINCT flag FROM magicport_vessel_directory/);
  assert.match(sql, /LIMIT 500/);
  assert.doesNotMatch(sql, /client|service_requests|quotations/i);
});

test("Client fleet listing remains owner-scoped and separate from global directory", async (t) => {
  const calls = [];
  t.mock.method(pool, "query", async (sql, values) => { calls.push([sql, values]); return { rows: [] }; });
  const res = { json(value) { this.body = value; return this; } };
  await getVessels({ user: { id: 19, role_id: 3 }, query: {} }, res);
  assert.match(calls[0][0], /FROM vessels/);
  assert.match(calls[0][0], /client_vessel_associations cva[\s\S]*cva.client_user_id=\$1/);
  assert.deepEqual(calls[0][1], [19]);
  assert.match(calls[0][0], /FROM vessels/);
});

test("Client Fleet search keeps the Client parameter separate from the search parameter", async (t) => {
  const calls = [];
  t.mock.method(pool, "query", async (sql, values) => { calls.push([sql, values]); return { rows: [] }; });
  const res = { json(value) { this.body = value; return this; } };
  await getVessels({ user: { id: 19, role_id: 3 }, query: { search: "Ocean" } }, res);
  assert.match(calls[0][0], /created_by_user_id=\$2/);
  assert.match(calls[0][0], /cva\.client_user_id=\$2/);
  assert.deepEqual(calls[0][1], ["%Ocean%", 19]);
});
