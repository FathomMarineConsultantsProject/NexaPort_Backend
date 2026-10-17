import assert from "node:assert/strict";
import test from "node:test";
import { createVessel } from "../src/controllers/vesselController.js";
import { pool } from "../src/config/db.js";

const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test("fleet registration rejects invalid IMO before database access", async (t) => {
  t.mock.method(pool, "connect", async () => { throw new Error("Database should not be accessed"); });
  const res = response();
  await createVessel({ user: { id: 20, role_id: 3 }, body: { vessel_name: "Ocean", imo_number: "1234560", vessel_type: "Tanker", flag_state: "Panama" } }, res);
  assert.equal(res.statusCode, 400);
});

test("fleet registration inserts normalized IMO into the expected column", async (t) => {
  const calls = [];
  t.mock.method(pool, "connect", async () => ({
    query: async (sql, values) => {
      calls.push([sql, values]);
      if (/SELECT id FROM vessels|FROM magicport_vessel_directory WHERE imo=|FROM vessels WHERE regexp_replace/.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO vessels/.test(sql)) return { rows: [{ id: 81, vessel_name: "Ocean", imo_number: "9620865" }], rowCount: 1 };
      if (/SELECT \* FROM vessels WHERE id=/.test(sql)) return { rows: [{ id: 81, vessel_name: "Ocean", imo_number: "9620865" }] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  }));
  const res = response();
  await createVessel({ user: { id: 20, role_id: 3 }, body: { vessel_name: "Ocean", imo_number: "IMO 9620865", vessel_type: "Tanker", flag_state: "Panama" } }, res);
  assert.equal(res.statusCode, 201);
  const insert = calls.find(([sql]) => sql.includes("INSERT INTO vessels"));
  assert.match(insert[0], /vessel_name,\s*imo_number,/);
  assert.equal(insert[1][1], "9620865");
  assert.ok(calls.some(([sql]) => /INSERT INTO client_submitted_vessel_directory/.test(sql)));
});
