import test from "node:test";
import assert from "node:assert/strict";
import { buildVesselDirectoryFilter, getVesselDirectoryDetail, listVesselDirectory } from "../src/services/vesselDirectoryService.js";
import { VESSEL_DIRECTORY_ROLES } from "../src/routes/vesselDirectoryRoutes.js";

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
