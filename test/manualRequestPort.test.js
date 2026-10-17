import assert from "node:assert/strict";
import test from "node:test";
import { findOrCreatePort } from "../src/utils/findOrCreatePort.js";

test("manual request port reuses a normalized existing identity under an advisory lock", async () => {
  const calls = [];
  const existing = { id: 7, port_name: "New Harbour", country: "India" };
  const queryable = { query: async (sql, values) => {
    calls.push([sql, values]);
    return { rows: sql.includes("FROM ports") ? [existing] : [] };
  } };
  assert.equal(await findOrCreatePort({ port_name: " New   Harbour ", country: " India ", queryable }), existing);
  assert.match(calls[0][0], /pg_advisory_xact_lock/);
  assert.deepEqual(calls[0][1], ["new harbour", "india"]);
  assert.deepEqual(calls[1][1], ["new harbour", "india"]);
  assert.ok(calls.every(([sql]) => !sql.includes("INSERT INTO ports")));
});

test("manual request port validates name and country before querying", async () => {
  let calls = 0;
  const queryable = { query: async () => { calls += 1; return { rows: [] }; } };
  await assert.rejects(findOrCreatePort({ port_name: "Harbour", country: " ", queryable }), { status: 400 });
  assert.equal(calls, 0);
});
