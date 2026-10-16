import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("all canonical directory sources have disjoint immutable ID namespaces", async () => {
  const migration = await readFile(new URL("../sql/directory_public_ids_001.sql", import.meta.url), "utf8");
  const backfill = await readFile(new URL("../scripts/backfillDirectoryPublicIds.js", import.meta.url), "utf8");
  const sources = [
    ["magicport_vessel_directory", "VSL"], ["vessels", "MVS"], ["ports", "PRT"],
    ["maritime_directory_entities", "COM"], ["flag_inspectors", "FLI"],
    ["accredited_inspectors", "ACI"], ["appointed_ship_surveyors", "APS"],
    ["master_flag_states", "FLG"], ["accreditation_schemes", "SCH"],
  ];
  assert.equal(new Set(sources.map(([, prefix]) => prefix)).size, sources.length);
  assert.match(migration, /OLD\.public_id IS NOT NULL AND NEW\.public_id IS DISTINCT FROM OLD\.public_id/);
  assert.match(migration, /gen_random_uuid\(\)/);
  assert.match(migration, /NEW\.public_id IS NULL AND NEW\.nexaport_id IS NULL/);
  assert.match(backfill, /WHERE nexaport_id IS NULL AND public_id IS NULL/);
  assert.match(backfill, /--apply/);
  for (const [table, prefix] of sources) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ADD COLUMN IF NOT EXISTS public_id text`));
    assert.match(migration, new RegExp(`EXECUTE FUNCTION public\\.assign_directory_public_id\\('${prefix}'\\)`));
    assert.match(backfill, new RegExp(`\\["${table}", "${prefix}"\\]`));
  }
});
