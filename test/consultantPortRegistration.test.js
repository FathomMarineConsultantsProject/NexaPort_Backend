import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSubmittedPorts,
  persistExpertPorts,
  resolveCoveragePorts,
} from "../src/controllers/consultantRegistrationController.js";

test("registration normalizes and deduplicates covered ports", () => {
  const errors = [];
  const ports = normalizeSubmittedPorts([" Singapore ", "singapore", "XYZ   Anchorage"], errors);
  assert.deepEqual(errors, []);
  assert.deepEqual(ports, ["Singapore", "XYZ Anchorage"]);
});

test("registration rejects unsafe custom port names", () => {
  const errors = [];
  const ports = normalizeSubmittedPorts(["<script>alert(1)</script>"], errors);
  assert.deepEqual(ports, []);
  assert.equal(errors.length, 1);
});

test("directory matches become canonical while custom coverage remains local", async () => {
  const client = {
    query: async () => ({ rows: [{ port_name: "Singapore" }] }),
  };
  const ports = await resolveCoveragePorts(client, ["singapore", "XYZ Anchorage"]);
  assert.deepEqual(ports, ["Singapore", "XYZ Anchorage"]);
});

test("multiple canonical and custom ports persist only to expert_ports", async () => {
  const calls = [];
  const client = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } };
  await persistExpertPorts(client, 42, ["Singapore", "Rotterdam", "XYZ Anchorage"]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ sql }) => /INSERT INTO expert_ports/.test(sql)));
  assert.ok(calls.every(({ sql }) => !/INSERT INTO ports\s/.test(sql)));
  assert.deepEqual(calls.map(({ values }) => values), [[42, "Singapore"], [42, "Rotterdam"], [42, "XYZ Anchorage"]]);
});
