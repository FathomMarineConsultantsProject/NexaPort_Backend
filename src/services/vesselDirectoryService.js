import { pool } from "../config/db.js";

const clean = (value) => String(value ?? "").trim();
const number = (value) => value === "" || value == null ? null : Number(value);

export function buildVesselDirectoryFilter(input = {}) {
  const page = Math.max(1, Number.parseInt(input.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(input.limit, 10) || 25));
  const values = [];
  const clauses = [];
  const add = (sql, value) => { values.push(value); clauses.push(sql.replaceAll("?", `$${values.length}`)); };
  if (clean(input.search)) add("(d.name ILIKE '%' || ? || '%' OR d.imo ILIKE '%' || ? || '%' OR d.mmsi ILIKE '%' || ? || '%' OR d.call_sign ILIKE '%' || ? || '%')", clean(input.search).slice(0, 120));
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
const publicFields = `d.id,d.name,d.imo,d.mmsi,d.call_sign,d.vessel_type,d.subtype,d.flag,d.class_label,d.dwt,d.gt,d.year_built,d.keel_year,d.loa,d.navigation_status,d.destination_text,d.destination_port_id,d.speed_knots,d.course_degrees,d.heading_degrees,d.observed_at,d.source_url,d.source_key,${managementSql} AS management`;

export async function listVesselDirectory(input, db = pool) {
  const f = buildVesselDirectoryFilter(input);
  const rows = await db.query(`SELECT ${publicFields} FROM magicport_vessel_directory d WHERE ${f.where} ORDER BY ${f.order} LIMIT $${f.values.length + 1} OFFSET $${f.values.length + 2}`, [...f.values, f.limit, f.offset]);
  const count = await db.query(`SELECT COUNT(*)::int AS total FROM magicport_vessel_directory d WHERE ${f.where}`, f.values);
  const total = count.rows[0]?.total || 0;
  return { vessels: rows.rows, pagination: { page: f.page, limit: f.limit, total, totalPages: Math.ceil(total / f.limit) } };
}

export async function getVesselDirectoryDetail(id, db = pool) {
  if (!/^\d+$/.test(String(id))) throw Object.assign(new Error("Invalid vessel ID"), { status: 400 });
  const result = await db.query(`SELECT ${publicFields}, s.payload->'faq' AS faq, s.payload->'additionalAttributes' AS additional_attributes, s.payload_hash FROM magicport_vessel_directory d JOIN magicport_vessel_sources s ON s.source_key=d.source_key WHERE d.id=$1`, [id]);
  return result.rows[0] || null;
}
