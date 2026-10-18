// Run only after sql/directory_public_ids_001.sql and sql/nexaport_public_ids_001.sql.
// Explicit --apply is required; each batch commits separately and is rerunnable.
import { pool } from "../src/config/db.js";

const tables = [
  ["magicport_vessel_directory", "VSL"], ["vessels", "MVS"],
  ["ports", "PRT"], ["maritime_directory_entities", "COM"],
  ["flag_inspectors", "FLI"], ["accredited_inspectors", "ACI"],
  ["appointed_ship_surveyors", "APS"],
  ["master_flag_states", "FLG"], ["accreditation_schemes", "SCH"],
];
const indexes = [
  "magicport_vessels_public_id_unique", "managed_vessels_public_id_unique",
  "ports_public_id_unique", "maritime_entities_public_id_unique",
  "flag_inspectors_public_id_unique", "accredited_inspectors_public_id_unique",
  "appointed_surveyors_public_id_unique", "flag_states_public_id_unique",
  "accreditation_schemes_public_id_unique", "experts_directory_public_id_unique",
  "experts_nexaport_id_unique",
];

if (!process.argv.includes("--apply")) {
  console.error("No changes made. Pass --apply after reviewing the target database and migration.");
  process.exitCode = 2;
} else {
  try {
    for (const index of indexes) {
      const check = await pool.query(`SELECT i.indisvalid,i.indisunique FROM pg_index i
        WHERE i.indexrelid=to_regclass($1)`, [`public.${index}`]);
      if (!check.rows[0]?.indisvalid || !check.rows[0]?.indisunique)
        throw new Error(`Required unique index ${index} is absent or invalid; repair migration before backfill`);
    }
    for (const [table, prefix] of tables) {
      const format = await pool.query(`SELECT COUNT(*)::int AS invalid FROM public.${table}
        WHERE public_id IS NOT NULL AND public_id !~ $1`, [`^${prefix}-[0-9A-F]{32}$`]);
      if (format.rows[0].invalid)
        throw new Error(`${table} contains existing public IDs outside its namespace`);
    }
    const expertFormat = await pool.query(`SELECT COUNT(*)::int AS invalid FROM public.experts
      WHERE public_id IS NOT NULL AND public_id !~ '^EXP-[0-9A-F]{32}$'`);
    if (expertFormat.rows[0].invalid)
      throw new Error("experts contains existing public IDs outside its namespace");
    for (const [table, prefix] of tables) {
      let updated = 0;
      for (;;) {
        const result = await pool.query(`WITH batch AS (
          SELECT id FROM public.${table} WHERE public_id IS NULL ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED
        ) UPDATE public.${table} t SET public_id=$1 || '-' || UPPER(REPLACE(gen_random_uuid()::text,'-',''))
          FROM batch WHERE t.id=batch.id AND t.public_id IS NULL`, [prefix]);
        updated += result.rowCount;
        if (result.rowCount === 0) break;
      }
      const check = await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE public_id IS NULL)::int AS missing,
        COUNT(DISTINCT public_id)::int AS unique_ids FROM public.${table}`);
      console.log(JSON.stringify({ table, updated, ...check.rows[0] }));
      if (check.rows[0].missing || check.rows[0].unique_ids !== check.rows[0].total)
        throw new Error(`${table} failed public ID coverage or uniqueness check`);
    }
    let expertUpdated = 0;
    for (;;) {
      const result = await pool.query(`WITH batch AS (
        SELECT id FROM public.experts WHERE nexaport_id IS NULL AND public_id IS NULL ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED
      ) UPDATE public.experts e SET public_id='EXP-' || UPPER(REPLACE(gen_random_uuid()::text,'-',''))
        FROM batch WHERE e.id=batch.id AND e.nexaport_id IS NULL AND e.public_id IS NULL`);
      expertUpdated += result.rowCount;
      if (result.rowCount === 0) break;
    }
    const experts = await pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE COALESCE(nexaport_id,public_id) IS NULL)::int AS missing, COUNT(DISTINCT COALESCE(nexaport_id,public_id))::int AS unique_ids FROM public.experts");
    console.log(JSON.stringify({ table: "experts", updated: expertUpdated, ...experts.rows[0] }));
    if (experts.rows[0].missing || experts.rows[0].unique_ids !== experts.rows[0].total)
      throw new Error("experts requires sql/nexaport_public_ids_001.sql or identity review");
    const globalIds = tables.map(([table]) => `SELECT public_id FROM public.${table}`).join(" UNION ALL ") +
      " UNION ALL SELECT COALESCE(nexaport_id,public_id) AS public_id FROM public.experts";
    const globalCheck = await pool.query(`SELECT COUNT(*)::bigint AS total,COUNT(DISTINCT public_id)::bigint AS unique_ids FROM (${globalIds}) ids`);
    console.log(JSON.stringify({ scope: "all_directories", ...globalCheck.rows[0] }));
    if (globalCheck.rows[0].total !== globalCheck.rows[0].unique_ids)
      throw new Error("Public IDs collide across canonical directory tables");
  } catch (error) {
    console.error("Directory ID backfill failed", { code: error.code || "UNKNOWN", message: error.message });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
