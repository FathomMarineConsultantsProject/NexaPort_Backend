import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../src/config/db.js";
import { createVessel } from "../src/controllers/vesselController.js";

test("client Fleet registration uses request vessel resolution and creates the directory marker in one transaction", async () => {
  const original = pool.connect;
  const calls = [];
  pool.connect = async () => ({ query: async (sql) => {
    calls.push(sql);
    if (/SELECT id FROM vessels/.test(sql) || /FROM magicport_vessel_directory WHERE imo=/.test(sql) || /FROM vessels WHERE regexp_replace/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO vessels/.test(sql)) return { rows: [{ id: 9, vessel_name: "Test Ship", imo_number: "9620865", vessel_type: "Tanker", flag_state: "Panama" }], rowCount: 1 };
    if (/SELECT \* FROM vessels WHERE id=/.test(sql)) return { rows: [{ id: 9, vessel_name: "Test Ship", imo_number: "9620865" }] };
    return { rows: [], rowCount: 1 };
  }, release() {} });
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(data) { this.data = data; return this; } };
  try {
    await createVessel({ user: { id: 3, role_id: 3 }, body: { vessel_name: "Test Ship", imo_number: "9620865", vessel_type: "Tanker", flag_state: "Panama" } }, res);
  } finally { pool.connect = original; }
  assert.equal(res.statusCode, 201);
  assert.ok(calls.some((sql) => /INSERT INTO client_submitted_vessel_directory/.test(sql)));
  assert.ok(calls.some((sql) => /INSERT INTO client_vessel_associations/.test(sql)));
  assert.equal(calls.at(-1), "COMMIT");
});
