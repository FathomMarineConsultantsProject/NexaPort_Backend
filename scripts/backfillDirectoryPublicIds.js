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

if (!process.argv.includes("--apply")) {
  console.error("No changes made. Pass --apply after reviewing the target database and migration.");
  process.exitCode = 2;
} else {
  try {
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
    const experts = await pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE COALESCE(public_id,nexaport_id) IS NULL)::int AS missing, COUNT(DISTINCT COALESCE(public_id,nexaport_id))::int AS unique_ids FROM public.experts");
    console.log(JSON.stringify({ table: "experts", updated: expertUpdated, ...experts.rows[0] }));
    if (experts.rows[0].missing || experts.rows[0].unique_ids !== experts.rows[0].total)
      throw new Error("experts requires sql/nexaport_public_ids_001.sql or identity review");
  } catch (error) {
    console.error("Directory ID backfill failed", { code: error.code || "UNKNOWN", message: error.message });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
