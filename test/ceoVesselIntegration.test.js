import assert from "node:assert/strict";
import test from "node:test";
import { listRequestVesselSuggestions, normalizeImo, resolveRequestVessel, validImo } from "../src/services/requestVesselService.js";

test("IMO normalization and checksum reject invalid identities", () => {
  assert.equal(normalizeImo("IMO 9620865"), "9620865");
  assert.equal(validImo("9620865"), true);
  assert.equal(validImo("9378654"), false);
});

test("suggestions are bounded and never fetch the whole directory", async () => {
  const calls = [];
  const db = { query: async (sql, values) => { calls.push([sql, values]); return { rows: [] }; } };
  const user = { id: 20, role_id: 3 };
  assert.deepEqual(await listRequestVesselSuggestions("a", user, db), []);
  assert.equal(calls.length, 0);
  await listRequestVesselSuggestions("Ocean", user, db);
  assert.match(calls[0][0], /LIMIT 12/);
  assert.match(calls[0][0], /magicport_vessel_directory/);
  assert.match(calls[0][0], /client_submitted_vessel_directory/);
  assert.match(calls[0][0], /cva.client_user_id=\$2/);
  assert.match(calls[0][0], /d.mmsi LIKE/);
  assert.match(calls[0][0], /d.call_sign ILIKE/);
  assert.deepEqual(calls[0][1], ["Ocean", 20, 3]);
});

test("existing imported IMO reuses canonical vessel and associates Client", async () => {
  const sql = [];
  const db = { query: async (statement, values) => {
    sql.push([statement, values]);
    if (statement.includes("FROM magicport_vessel_directory WHERE imo=")) return { rows: [{ id: 4, imo: "9620865", name: "OCEAN", vessel_type: "Tanker", flag: "Panama", master_vessel_id: 5 }] };
    if (statement.includes("FROM vessels WHERE regexp_replace")) return { rows: [{ id: 5, imo_number: "9620865", vessel_name: "OCEAN", vessel_type: "Tanker", flag_state: "Panama" }] };
    return { rows: [] };
  } };
  const vessel = await resolveRequestVessel(db, { vesselName: "Old spelling", imoNumber: "IMO 9620865" }, 20);
  assert.equal(vessel.id, 5);
  assert.equal(vessel.name, "OCEAN");
  assert.ok(sql.some(([statement]) => statement.includes("INSERT INTO client_vessel_associations")));
  assert.ok(sql.every(([statement]) => !statement.includes("INSERT INTO vessels")));
});

test("missing IMO creates an unverified provisional identity without matching by name", async () => {
  const sql = [];
  const db = { query: async (statement, values) => {
    sql.push([statement, values]);
    if (statement.includes("INSERT INTO vessels")) return { rows: [{ id: 71, vessel_name: "SAME NAME", imo_number: null, vessel_type: "Not provided", flag_state: "Not provided" }] };
    return { rows: [] };
  } };
  const vessel = await resolveRequestVessel(db, { vesselName: "SAME NAME" }, 20);
  assert.equal(vessel.id, 71);
  assert.equal(vessel.imo, null);
  assert.ok(sql.some(([statement]) => statement.includes("client_submitted_vessel_directory")));
  assert.ok(sql.every(([statement]) => !statement.includes("FROM vessels WHERE regexp_replace")));
});

test("invalid IMO fails before a database write", async () => {
  const db = { query: async () => { throw new Error("Unexpected query"); } };
  await assert.rejects(resolveRequestVessel(db, { imoNumber: "9378654" }, 20), { status: 400, fieldErrors: { imoNumber: "Enter a valid seven-digit IMO number." } });
});

test("new valid IMO creates one unverified vessel identity and association", async () => {
  const sql = [];
  const db = { query: async (statement, values) => {
    sql.push([statement, values]);
    if (statement.includes("INSERT INTO vessels")) return { rows: [{ id: 81, vessel_name: "OCEAN", imo_number: "9620865", vessel_type: "Tanker", flag_state: "Panama" }] };
    return { rows: [] };
  } };
  const vessel = await resolveRequestVessel(db, { vesselName: "OCEAN", imoNumber: "9620865", vesselType: "Tanker", flagState: "Panama" }, 20);
  assert.equal(vessel.id, 81);
  assert.ok(sql.some(([statement]) => statement.includes("INSERT INTO client_submitted_vessel_directory")));
  assert.ok(sql.some(([statement, values]) => statement.includes("INSERT INTO client_vessel_associations") && values[0] === 20 && values[1] === 81));
});

test("a Client cannot claim a different Client's private IMO identity", async () => {
  const calls = [];
  const db = { query: async (statement, values) => {
    calls.push([statement, values]);
    if (statement.includes("FROM vessels WHERE regexp_replace")) return { rows: [{ id: 81, vessel_name: "OCEAN", imo_number: "9620865", vessel_type: "Tanker", flag_state: "Panama" }] };
    return { rows: [] };
  } };
  await assert.rejects(resolveRequestVessel(db, { vesselName: "Ocean Two", imoNumber: "9620865" }, 21), { status: 403 });
  assert.ok(calls.every(([statement]) => !statement.includes("INSERT INTO vessels")));
  assert.ok(calls.every(([statement]) => !statement.includes("INSERT INTO client_vessel_associations")));
});

test("an IMO insert race cannot associate the other Client's winning private vessel", async () => {
  let lookups = 0; const calls = [];
  const db = { query: async (statement) => {
    calls.push(statement);
    if (statement.includes("FROM vessels WHERE regexp_replace")) {
      lookups += 1;
      return { rows: lookups === 1 ? [] : [{ id: 81, vessel_name: "OCEAN", imo_number: "9620865", created_by_user_id: 99 }] };
    }
    if (statement.includes("INSERT INTO vessels")) return { rows: [] };
    return { rows: [], rowCount: 0 };
  } };
  await assert.rejects(resolveRequestVessel(db, { vesselName: "OCEAN", imoNumber: "9620865" }, 21), { status: 403 });
  assert.ok(calls.every((statement) => !statement.includes("INSERT INTO client_vessel_associations")));
});

test("selected private vessel requires an existing client association", async () => {
  const calls = [];
  const db = { query: async (statement, values) => { calls.push([statement, values]); return { rows: [] }; } };
  await assert.rejects(resolveRequestVessel(db, { selectedVessel: { source: "client_submitted", id: 81 } }, 21), { status: 400 });
  assert.match(calls[0][0], /client_vessel_associations/);
  assert.deepEqual(calls[0][1], [81, 21]);
});

test("conflicting IMO and selected imported vessel are rejected without association", async () => {
  const calls = [];
  const db = { query: async (statement) => {
    calls.push(statement);
    if (statement.includes("FROM magicport_vessel_directory WHERE id=")) return { rows: [{ id: 4, imo: "9620865", name: "OCEAN" }] };
    return { rows: [] };
  } };
  await assert.rejects(resolveRequestVessel(db, { selectedVessel: { source: "imported", id: 4 }, imoNumber: "9074729" }, 20), { status: 400 });
  assert.ok(calls.every((statement) => !statement.includes("INSERT INTO client_vessel_associations")));
});
