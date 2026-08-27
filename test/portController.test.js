import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { buildPortListQuery, normalizePortPayload } from "../src/controllers/portController.js";

test("port list defaults to server pagination and caps requested limits", () => {
  assert.deepEqual(buildPortListQuery({}).page, 1);
  assert.deepEqual(buildPortListQuery({}).limit, 25);
  assert.deepEqual(buildPortListQuery({ page: "3", limit: "500" }).limit, 100);
  assert.deepEqual(buildPortListQuery({ page: "3", limit: "50" }).offset, 100);
});

test("port list builds name, country, UNLOCODE and directory filters", () => {
  const result = buildPortListQuery({ search: "Singapore", country: "Singapore", region: "Asia Pacific", harbourType: "Coastal" });
  assert.match(result.where, /port_name ILIKE/);
  assert.match(result.where, /country ILIKE/);
  assert.match(result.where, /unlocode ILIKE/);
  assert.match(result.where, /LOWER\(p\.country\)/);
  assert.match(result.where, /LOWER\(p\.region\)/);
  assert.match(result.where, /LOWER\(p\.harbour_type\)/);
  assert.deepEqual(result.values, ["Singapore", "Singapore", "Asia Pacific", "Coastal"]);
});

test("compact mode remains a lightweight legacy-compatible port list", () => {
  const result = buildPortListQuery({ search: "SGSIN", compact: "true" });
  assert.equal(result.compact, true);
  assert.equal(result.limit, 50);
});

test("simple admin port creation still requires only name, country and region", () => {
  assert.deepEqual(normalizePortPayload({ port_name: "Test Port", country: "India", region: "Asia Pacific" }), {
    port_name: "Test Port", country: "India", region: "Asia Pacific", psc_risk_level: "Medium", experts_available: 0, vessel_types: undefined, services: undefined,
  });
});

test("enriched port input normalizes UNLOCODE and validates coordinates", () => {
  const result = normalizePortPayload({ port_name: "Singapore", country: "Singapore", region: "Asia Pacific", unlocode: " sgsin ", latitude: "1.29", longitude: "103.85", depths: { channel_depth: { raw: "15 m" } } });
  assert.equal(result.unlocode, "SGSIN");
  assert.equal(result.country_iso, "SG");
  assert.equal(result.latitude, 1.29);
  assert.deepEqual(result.depths, { channel_depth: { raw: "15 m" } });
  assert.throws(() => normalizePortPayload({ port_name: "X", country: "Y", region: "Z", latitude: 91 }), /latitude/);
});

test("partial edits preserve omitted and empty nested JSON fields", () => {
  const result = normalizePortPayload({ description: "Updated", restrictions: {} }, { partial: true });
  assert.equal(result.description, "Updated");
  assert.equal(result.restrictions, undefined);
  assert.equal(result.depths, undefined);
});

test("port write routes remain admin-only", async () => {
  const routes = await fs.readFile(new URL("../src/routes/portRoutes.js", import.meta.url), "utf8");
  for (const method of ["post", "patch", "delete"]) assert.match(routes, new RegExp(`router\\.${method}\\([^\\n]+allowRoles\\(1\\)`));
});
