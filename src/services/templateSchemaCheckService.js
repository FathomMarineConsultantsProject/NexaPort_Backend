import { pool } from "../config/db.js";

const REQUIRED_TABLES = ["inspection_templates", "inspection_template_versions", "inspection_reports", "inspection_report_photos"];

const REQUIRED_COLUMNS = {
  inspection_templates: ["id", "expert_id", "title", "description", "source_type", "extraction_method", "status", "extraction_status", "current_version_number", "has_photo_fields", "template_scope", "created_by_user_id"],
  inspection_template_versions: ["id", "template_id", "version_number", "fields_jsonb", "layout_jsonb", "created_by_user_id"],
  inspection_reports: ["id", "template_id", "template_version_id", "expert_id", "created_by_user_id", "title", "status", "values_jsonb"],
  inspection_report_photos: ["id", "report_id", "field_key", "photo_s3_key"],
};

let cache = null;
let cacheTime = 0;
const CACHE_TTL_MS = 30000;

export async function checkTemplateRuntimeSchema(queryable = pool, { forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cache && (now - cacheTime < CACHE_TTL_MS)) {
    return cache;
  }

  const result = {
    ready: true,
    missingTables: [],
    missingColumns: [],
    constraintMismatches: [],
    typeMismatches: [],
  };

  try {
    const tableRes = await queryable.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1)",
      [REQUIRED_TABLES]
    );
    const foundTables = new Set(tableRes.rows.map((r) => r.table_name));

    for (const table of REQUIRED_TABLES) {
      if (!foundTables.has(table)) {
        result.missingTables.push(table);
        result.ready = false;
      }
    }

    if (result.ready) {
      const colRes = await queryable.query(
        "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1)",
        [REQUIRED_TABLES]
      );
      const tableCols = new Map();
      for (const row of colRes.rows) {
        if (!tableCols.has(row.table_name)) tableCols.set(row.table_name, new Set());
        tableCols.get(row.table_name).add(row.column_name);
      }

      for (const [table, reqCols] of Object.entries(REQUIRED_COLUMNS)) {
        const existing = tableCols.get(table) || new Set();
        for (const col of reqCols) {
          if (!existing.has(col)) {
            result.missingColumns.push(`${table}.${col}`);
            result.ready = false;
          }
        }
      }

      const constraintRes = await queryable.query(
        "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.inspection_templates'::regclass"
      );
      const stCheck = constraintRes.rows.find((c) => c.conname === "inspection_templates_source_type_check");
      if (stCheck && !stCheck.def.includes("'manual'")) {
        result.constraintMismatches.push("inspection_templates_source_type_check lacks 'manual'");
        result.ready = false;
      }
    }
  } catch (err) {
    result.ready = false;
    result.error = err.message;
  }

  cache = result;
  cacheTime = now;
  return result;
}

export function resetSchemaCheckCache() {
  cache = null;
  cacheTime = 0;
}
