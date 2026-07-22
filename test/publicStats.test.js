import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getPlatformStats } from "../src/controllers/publicStatsController.js";
import { pool } from "../src/config/db.js";

const source = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
const response = () => ({
  statusCode: 200,
  headers: {},
  body: null,
  set(name, value) { this.headers[name] = value; return this; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test("public platform statistics require no JWT and return only aggregate counts", async () => {
  const original = pool.query;
  pool.query = async (sql) => {
    assert.match(sql, /u\.role_id\s*=\s*2\s+AND\s+u\.is_active\s*=\s*TRUE/);
    assert.match(sql, /JOIN public\.experts e\s+ON e\.user_id\s*=\s*u\.id/);
    assert.match(sql, /public\.flag_inspectors\s+WHERE COALESCE\(is_active,\s*TRUE\)\s*=\s*TRUE/);
    assert.match(sql, /public\.accredited_inspectors\s+WHERE COALESCE\(is_active,\s*TRUE\)\s*=\s*TRUE/);
    assert.match(sql, /public\.appointed_ship_surveyors\s+WHERE COALESCE\(is_active,\s*TRUE\)\s*=\s*TRUE/);
    return { rows: [{ nexaport_consultants: 10, flag_inspectors: 20, accredited_inspectors: 30, appointed_ship_surveyors: 40 }] };
  };
  try {
    const res = response();
    await getPlatformStats({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.maritime_professionals_total, 100);
    assert.equal(res.body.data.directory_entries_total, 100);
    assert.deepEqual(res.body.data.breakdown, { nexaport_consultants: 10, flag_inspectors: 20, accredited_inspectors: 30, appointed_ship_surveyors: 40 });
    assert.equal(Object.values(res.body.data.breakdown).reduce((sum, value) => sum + value, 0), res.body.data.maritime_professionals_total);
    assert.doesNotMatch(JSON.stringify(res.body), /email|phone|user_id|full_name/);
  } finally { pool.query = original; }
});

test("public platform statistics return a safe database failure", async () => {
  const original = pool.query;
  const originalError = console.error;
  pool.query = async () => { throw new Error("sensitive database detail"); };
  console.error = () => {};
  try {
    const res = response();
    await getPlatformStats({}, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, "Platform statistics are temporarily unavailable.");
    assert.doesNotMatch(JSON.stringify(res.body), /sensitive database detail/);
  } finally { pool.query = original; console.error = originalError; }
});

test("public stats route is unauthenticated while directory permissions remain protected", async () => {
  const [statsRoutes, app, flagRoutes, accreditedRoutes, appointedRoutes] = await Promise.all([
    source("src/routes/publicStatsRoutes.js"), source("src/app.js"), source("src/routes/flagRoutes.js"), source("src/routes/accreditedInspectorRoutes.js"), source("src/routes/appointedSurveyorRoutes.js"),
  ]);
  assert.match(statsRoutes, /router\.get\("\/platform-stats", getPlatformStats\)/);
  assert.doesNotMatch(statsRoutes, /requireAuth|allowRoles/);
  assert.match(app, /app\.use\("\/api\/public", publicStatsRoutes\)/);
  assert.match(flagRoutes, /directory", requireAuth, allowRoles\(1\)/);
  assert.match(accreditedRoutes, /requireAuth,\s*allowRoles\(1\)/);
  assert.match(appointedRoutes, /requireAuth, allowRoles\(1\)/);
});
