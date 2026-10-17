// Read-only diagnosis using the backend's configured PostgreSQL connection.
// Prints no credentials, SQL, vessel names, or source payloads.
import { pool } from "../src/config/db.js";
import { listVesselDirectory } from "../src/services/vesselDirectoryService.js";

const required = [
  "magicport_vessel_directory", "magicport_vessel_management",
  "magicport_vessel_sources", "client_submitted_vessel_directory", "vessels",
];

const captured = [];
await listVesselDirectory({ page: 1, limit: 30 }, {
  query: async (sql, values) => {
    captured.push({ sql, values });
    return { rows: sql.includes("COUNT(*)") ? [{ total: 0 }] : [] };
  },
});

const client = await pool.connect().catch((error) => {
  console.error(JSON.stringify({ stage: "connect", code: error.code || "UNKNOWN" }));
  process.exitCode = 1;
  return null;
});

if (client) {
  const read = async (stage, sql, values = []) => {
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '20s'");
      const result = await client.query(sql, values);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(JSON.stringify({ stage, code: error.code || "UNKNOWN", table: error.table || null, column: error.column || null }));
      process.exitCode = 1;
      return null;
    }
  };
  try {
    for (const table of required) {
      const relation = await read(`table:${table}`, "SELECT to_regclass($1) AS relation", [`public.${table}`]);
      console.log(JSON.stringify({ table, exists: Boolean(relation?.rows[0]?.relation) }));
      if (!relation?.rows[0]?.relation) continue;
      const count = await read(`count:${table}`, `SELECT COUNT(*)::bigint AS total FROM public.${table}`);
      if (count) console.log(JSON.stringify({ table, total: count.rows[0].total }));
    }
    const columns = await read("columns", `SELECT table_name,column_name,data_type
      FROM information_schema.columns WHERE table_schema='public'
      AND table_name=ANY($1::text[]) AND column_name=ANY($2::text[])
      ORDER BY table_name,column_name`, [required,
      ["id", "public_id", "source_key", "master_vessel_id", "vessel_id", "directory_id", "name", "imo"]]);
    if (columns) console.log(JSON.stringify({ columns: columns.rows }));
    for (const [index, query] of captured.entries()) {
      const stage = index === 0 ? "directory-page" : "directory-count";
      const result = await read(stage, query.sql, query.values);
      if (result) console.log(JSON.stringify({ stage, returned: result.rows.length, total: stage === "directory-count" ? result.rows[0]?.total : undefined }));
    }
  } finally {
    client.release();
    await pool.end();
  }
}
