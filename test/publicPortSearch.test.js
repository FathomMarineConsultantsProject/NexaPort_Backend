import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildPublicPortSearchQuery,
  createPublicPortSearchHandler,
} from "../src/controllers/publicPortController.js";

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test("public port search requires at least two characters and caps results", () => {
  assert.match(buildPublicPortSearchQuery({ search: "x" }).error, /at least 2/);
  const query = buildPublicPortSearchQuery({ search: "  sing  ", limit: "500" });
  assert.deepEqual(query.values, ["sing", 50]);
  assert.match(query.text, /p\.is_active = true/);
});

test("public search covers name, country and UNLOCODE with parameterized SQL", () => {
  const query = buildPublicPortSearchQuery({ search: "Singapore", limit: 10 });
  assert.match(query.text, /p\.port_name ILIKE/);
  assert.match(query.text, /p\.country ILIKE/);
  assert.match(query.text, /p\.unlocode ILIKE/);
  assert.doesNotMatch(query.text, /Singapore/);
  assert.deepEqual(query.values, ["Singapore", 10]);
});

test("unauthenticated handler returns only approved public fields", async () => {
  const handler = createPublicPortSearchHandler({
    query: async () => ({ rows: [{ id: 1, port_name: "Singapore", country: "Singapore", region: "Asia Pacific", unlocode: "SGSIN", source_url: "private", experts_available: 9 }] }),
  });
  const res = response();
  await handler({ query: { search: "sing" }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body.ports[0]), ["id", "port_name", "country", "region", "unlocode"]);
});

test("public route has no auth middleware and protected port route is unchanged", async () => {
  const [publicRoutes, protectedRoutes] = await Promise.all([
    readFile(new URL("../src/routes/publicPortRoutes.js", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/portRoutes.js", import.meta.url), "utf8"),
  ]);
  assert.match(publicRoutes, /router\.get\("\/ports\/search", searchPublicPorts\)/);
  assert.doesNotMatch(publicRoutes, /requireAuth|requireApprovedClient/);
  assert.match(protectedRoutes, /router\.get\("\/", requireAuth, requireApprovedClient, getPorts\)/);
});
