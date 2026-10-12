import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = () => readFile(new URL("../sql/nexaport_public_ids_001.sql", import.meta.url), "utf8");
const controller = (name) => readFile(new URL(`../src/controllers/${name}`, import.meta.url), "utf8");

test("migration keeps internal keys and makes public IDs unique with yearly transactional counters", async () => {
  const sql = await migration();
  assert.match(sql, /ADD COLUMN IF NOT EXISTS nexaport_id TEXT/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS experts_nexaport_id_unique/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS experts_registered_user_unique/);
  assert.match(sql, /allocation_year INTEGER PRIMARY KEY/);
  assert.match(sql, /ON CONFLICT\(allocation_year\) DO UPDATE[\s\S]*last_sequence=counters\.last_sequence\+1/);
  assert.match(sql, /LPAD\(next_sequence::text,GREATEST\(3,LENGTH\(next_sequence::text\)\),'0'\)/);
  assert.match(sql, /Asia\/Kolkata/);
  assert.doesNotMatch(sql, /ALTER (?:TABLE|COLUMN).*\b(?:users\.id|experts\.id)\b/i);
});

test("backfill is deterministic, preserves issued IDs, and excludes anonymous imports", async () => {
  const sql = await migration();
  assert.match(sql, /GREATEST\(counters\.last_sequence,EXCLUDED\.last_sequence\)/);
  assert.match(sql, /JOIN public\.users u ON u\.id=e\.user_id/);
  assert.match(sql, /WHERE e\.nexaport_id IS NULL/);
  assert.match(sql, /ORDER BY COALESCE\(e\.created_at,u\.created_at\) NULLS LAST,e\.id/);
  assert.match(sql, /Existing profiles without either expert or user creation timestamp/);
  assert.match(sql, /Issued Nexaport IDs cannot be changed/);
  assert.match(sql, /Issued Nexaport IDs cannot be transferred/);
  assert.doesNotMatch(sql, /flag_inspectors|accredited_inspectors|appointed_ship_surveyors/);
});

test("registration is database-assigned, profile edits reject submitted IDs, and missing migration rolls back", async () => {
  const registration = await controller("consultantRegistrationController.js");
  const expert = await controller("expertController.js");
  assert.match(registration, /req\.body\?\.nexaport_id/);
  assert.match(expert, /req\.body\?\.nexaport_id/g);
  assert.match(registration, /if \(!expert\.nexaport_id\)/);
  assert.match(expert, /if \(expertUserId && !expert\.nexaport_id\)/);
  assert.match(registration, /await client\.query\("ROLLBACK"\)/);
  assert.match(expert, /await client\.query\("ROLLBACK"\)/);
});
