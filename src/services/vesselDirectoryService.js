import { pool } from "../config/db.js";
import { logDatabaseError } from "../config/databaseErrors.js";

const clean = (value) => String(value ?? "").trim();
const number = (value) => value === "" || value == null ? null : Number(value);

export function buildVesselDirectoryFilter(input = {}) {
  const page = Math.max(1, Number.parseInt(input.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(input.limit, 10) || 25));
  const values = [];
  const clauses = [];
  const add = (sql, value) => { values.push(value); clauses.push(sql.replaceAll("?", `$${values.length}`)); };
  if (clean(input.search)) add("(d.name ILIKE '%' || ? || '%' OR d.imo ILIKE '%' || ? || '%' OR d.mmsi ILIKE '%' || ? || '%' OR d.call_sign ILIKE '%' || ? || '%' OR d.public_id = ? OR EXISTS (SELECT 1 FROM magicport_vessel_directory imported JOIN vessels linked ON linked.id=imported.master_vessel_id WHERE imported.public_id=d.public_id AND linked.public_id=?))", clean(input.search).slice(0, 120));
  if (clean(input.type)) add("d.vessel_type = ?", clean(input.type).slice(0, 80));
  if (clean(input.flag)) add("d.flag = ?", clean(input.flag).slice(0, 80));
  for (const [key, column, op] of [["dwtMin", "d.dwt", ">="], ["dwtMax", "d.dwt", "<="], ["gtMin", "d.gt", ">="], ["gtMax", "d.gt", "<="]]) {
    const value = number(input[key]);
    if (value != null) {
      if (!Number.isFinite(value) || value < 0) throw Object.assign(new Error(`${key} must be a nonnegative number`), { status: 400 });
      add(`${column} ${op} ?`, value);
    }
  }
  const sortMap = { name: "d.name", imo: "d.imo", dwt: "d.dwt", gt: "d.gt", yearBuilt: "d.year_built" };
  const sort = sortMap[input.sort] || sortMap.name;
  const direction = input.direction === "desc" ? "DESC" : "ASC";
  return { page, limit, offset: (page - 1) * limit, where: clauses.length ? clauses.join(" AND ") : "TRUE", values, order: `${sort} ${direction} NULLS LAST, d.id ASC` };
}

const managementSql = `COALESCE((SELECT jsonb_agg(jsonb_build_object('role',m.role,'name',m.name,'sourceUrl',m.source_url,'entityId',m.entity_id) ORDER BY m.ordinal) FROM magicport_vessel_management m WHERE m.directory_id=d.id),'[]'::jsonb)`;
const publicFields = `d.id,d.public_id,d.name,d.imo,d.mmsi,d.call_sign,d.vessel_type,d.subtype,d.flag,d.class_label,d.dwt,d.gt,d.year_built,d.keel_year,d.loa,d.navigation_status,d.destination_text,d.destination_port_id,d.speed_knots,d.course_degrees,d.heading_degrees,d.observed_at,d.source_url,d.source_key,${managementSql} AS management`;
const discoverySql = `SELECT d.id::text AS id,d.public_id,d.name,d.imo,d.mmsi,d.call_sign,d.vessel_type,d.subtype,d.flag,d.class_label,d.dwt,d.gt,d.year_built,d.keel_year,d.loa,d.navigation_status,d.destination_text,d.destination_port_id,d.speed_knots,d.course_degrees,d.heading_degrees,d.observed_at,d.source_url,d.source_key,${managementSql} AS management,'MagicPort'::text AS provenance FROM magicport_vessel_directory d
  UNION ALL SELECT 'client-'||v.id,v.public_id,v.vessel_name,v.imo_number,NULL,NULL,v.vessel_type,NULL,v.flag_state,NULL,v.dwt,v.gt,v.year_built,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL::text,'[]'::jsonb,'Client-submitted · unverified' FROM client_submitted_vessel_directory cd JOIN vessels v ON v.id=cd.vessel_id WHERE v.is_active=TRUE AND NOT EXISTS (SELECT 1 FROM magicport_vessel_directory imported WHERE imported.master_vessel_id=v.id OR (v.imo_number IS NOT NULL AND imported.imo=v.imo_number))`;

export async function listVesselDirectory(input, db = pool) {
  const f = buildVesselDirectoryFilter(input);
  let rows;
  try { rows = await db.query(`WITH discovery AS (${discoverySql}) SELECT d.* FROM discovery d WHERE ${f.where} ORDER BY ${f.order} LIMIT $${f.values.length + 1} OFFSET $${f.values.length + 2}`, [...f.values, f.limit, f.offset]); }
  catch (error) { logDatabaseError("Vessel directory page query", error); throw error; }
  let count;
  try { count = await db.query(`WITH discovery AS (${discoverySql}) SELECT COUNT(*)::int AS total FROM discovery d WHERE ${f.where}`, f.values); }
  catch (error) { logDatabaseError("Vessel directory count query", error); throw error; }
  const total = count.rows[0]?.total || 0;
  return { vessels: rows.rows, pagination: { page: f.page, limit: f.limit, total, totalPages: Math.ceil(total / f.limit) } };
}

export async function listVesselDirectoryFlags(db = pool) {
  const result = await db.query(`SELECT DISTINCT flag FROM magicport_vessel_directory
    WHERE flag IS NOT NULL AND flag <> '' ORDER BY flag LIMIT 500`);
  return result.rows.map((row) => row.flag);
}

export async function getVesselDirectoryDetail(id, db = pool) {
  if (/^client-\d+$/.test(String(id)) || /^MVS-[0-9A-F]{32}$/.test(String(id))) {
    const legacyId = String(id).startsWith("client-");
    // The foreign key is verified identity. Resolve an old managed reference to
    // the imported record without changing either stored public ID.
    const linked = await db.query(`SELECT ${publicFields}, s.payload->'faq' AS faq, s.payload->'additionalAttributes' AS additional_attributes, s.payload_hash
      FROM magicport_vessel_directory d JOIN vessels v ON v.id=d.master_vessel_id
      JOIN magicport_vessel_sources s ON s.source_key=d.source_key
      WHERE ${legacyId ? "v.id" : "v.public_id"}=$1`, [legacyId ? Number(String(id).slice(7)) : id]);
    if (linked.rows[0]) return linked.rows[0];
    const result = await db.query(`SELECT 'client-'||v.id AS id,v.public_id,v.vessel_name AS name,v.imo_number AS imo,
      v.vessel_type,v.flag_state AS flag,v.dwt,v.gt,v.year_built,
      'Client-submitted · unverified' AS provenance,'[]'::jsonb AS management
      FROM client_submitted_vessel_directory cd JOIN vessels v ON v.id=cd.vessel_id
      WHERE ${legacyId ? "v.id=$1" : "v.public_id=$1"} AND v.is_active=TRUE`, [legacyId ? Number(String(id).slice(7)) : id]);
    return result.rows[0] || null;
  }
  if (!/^\d+$/.test(String(id)) && !/^VSL-[0-9A-F]{32}$/.test(String(id))) throw Object.assign(new Error("Invalid vessel ID"), { status: 400 });
  const result = await db.query(`SELECT ${publicFields}, s.payload->'faq' AS faq, s.payload->'additionalAttributes' AS additional_attributes, s.payload_hash FROM magicport_vessel_directory d JOIN magicport_vessel_sources s ON s.source_key=d.source_key WHERE ${/^\d+$/.test(String(id)) ? "d.id" : "d.public_id"}=$1`, [id]);
  return result.rows[0] || null;
}
