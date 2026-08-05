import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("maritime company registration is transactional, pending, and server-controlled as role 4", async () => {
  const service = await source("../src/services/maritimeCompanyService.js");
  assert.match(service, /await client\.query\("BEGIN"\)/);
  assert.match(service, /await client\.query\("COMMIT"\)/);
  assert.match(service, /await client\.query\("ROLLBACK"\)/);
  assert.match(service, /VALUES \(\$1,\$2,\$3,\$4,4,\$5,true\)/);
  assert.match(service, /'self_registered','pending'/);
  assert.match(service, /types\.length !== 1/);
  assert.match(service, /maritime_company_accounts \(user_id,entity_id,primary_type\)/);
});

test("company profile routes require authentication and role 4", async () => {
  const routes = await source("../src/routes/maritimeCompanyRoutes.js");
  assert.match(routes, /router\.use\(requireAuth, allowRoles\(4\)\)/);
  assert.match(routes, /router\.get\("\/profile"/);
  assert.match(routes, /router\.patch\("\/profile"/);
});

test("standalone migration preserves imported multi-type records and guards company single-type records", async () => {
  const sql = await source("../sql/maritime_company_accounts_001.sql");
  assert.match(sql, /BEGIN;/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.maritime_company_accounts/);
  assert.match(sql, /entity_id UUID NOT NULL UNIQUE/);
  assert.match(sql, /primary_type IN \('service_provider','ship_agent','supplier'\)/);
  assert.match(sql, /maritime_company_single_type_guard/);
  assert.doesNotMatch(sql, /DELETE FROM public\.maritime_directory_entities/i);
});
