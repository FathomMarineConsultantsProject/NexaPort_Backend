import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getExpertInspectionCapabilities,
  normalizeInspectionMethodIds,
  replaceExpertInspectionMethods,
  validateInspectionMethodIds,
} from "../src/services/inspectionCatalogueService.js";

test("inspection capability IDs dedupe while preserving order", () => {
  assert.deepEqual(normalizeInspectionMethodIds([4, "17", 4, 22, "17"]), [4, 17, 22]);
});

test("invalid inspection capability ID is rejected", () => {
  assert.throws(() => normalizeInspectionMethodIds([4, "bad"]), /valid method IDs/);
});

test("inactive or missing inspection method is rejected", async () => {
  const queryable = {
    async query() {
      return { rows: [{ id: 4 }] };
    },
  };

  await assert.rejects(
    () => validateInspectionMethodIds(queryable, [4, 17]),
    /exist and be active/
  );
});

test("capability replacement deletes stale rows and inserts deduped active methods", async () => {
  const calls = [];
  const queryable = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/FROM inspection_methods m/.test(sql)) return { rows: [{ id: 4 }, { id: 17 }] };
      return { rows: [] };
    },
  };

  const ids = await replaceExpertInspectionMethods(queryable, 9, [4, 17, 4]);

  assert.deepEqual(ids, [4, 17]);
  assert.match(calls[1].sql, /DELETE FROM expert_inspection_methods/);
  assert.equal(calls.filter((call) => /INSERT INTO expert_inspection_methods/.test(call.sql)).length, 2);
  assert.deepEqual(calls.at(-1).values, [9, 17]);
});

test("expert capabilities are returned grouped by catalogue vertical", async () => {
  const queryable = {
    async query() {
      return { rows: [
        { vertical_id: 1, vertical_slug: "navigation", vertical_name: "Navigation", method_id: 4, method_slug: "ecdis-audits", method_name: "ECDIS Audits" },
        { vertical_id: 1, vertical_slug: "navigation", vertical_name: "Navigation", method_id: 17, method_slug: "navigation-audits", method_name: "Navigation Audits" },
      ] };
    },
  };

  assert.deepEqual(await getExpertInspectionCapabilities(queryable, 9), [{
    id: 1,
    slug: "navigation",
    name: "Navigation",
    methods: [
      { id: 4, slug: "ecdis-audits", name: "ECDIS Audits" },
      { id: 17, slug: "navigation-audits", name: "Navigation Audits" },
    ],
  }]);
});

test("registration, profile edit, and matching use expert inspection capabilities", async () => {
  const [registration, expertController, dashboard, migration] = await Promise.all([
    readFile(new URL("../src/controllers/consultantRegistrationController.js", import.meta.url), "utf8"),
    readFile(new URL("../src/controllers/expertController.js", import.meta.url), "utf8"),
    readFile(new URL("../src/controllers/dashboardController.js", import.meta.url), "utf8"),
    readFile(new URL("../sql/consultant_inspection_capabilities_001.sql", import.meta.url), "utf8"),
  ]);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.expert_inspection_methods/);
  assert.match(migration, /PRIMARY KEY \(expert_id, inspection_method_id\)/);
  assert.match(migration, /JOIN public\.experts e\s+ON e\.id = erd\.expert_id/);
  assert.match(registration, /await client\.query\("BEGIN"\)/);
  assert.match(registration, /replaceExpertInspectionMethods\(client, expert\.id, data\.inspectionMethodIds\)/);
  assert.match(expertController, /inspection_capabilities: inspectionCapabilities/);
  assert.match(expertController, /replaceExpertInspectionMethods\(\s*client,\s*id,/);
  assert.match(dashboard, /sr\.inspection_method_id IS NOT NULL/);
  assert.match(dashboard, /eim\.inspection_method_id = sr\.inspection_method_id/);
  assert.match(dashboard, /Inspection capability/);
});
