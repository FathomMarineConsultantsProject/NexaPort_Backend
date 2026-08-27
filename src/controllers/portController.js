import { pool } from "../config/db.js";
import { createPresignedGetUrl } from "../utils/s3Presign.js";

const ENRICHMENT_FIELDS = [
  "unlocode", "country_iso", "latitude", "longitude", "harbour_type", "harbour_size", "max_draft_m",
  "depths", "restrictions", "equipment", "navigation", "communication", "additional_attributes",
];
const JSON_FIELDS = new Set(["depths", "restrictions", "equipment", "navigation", "communication", "additional_attributes"]);
const NUMBER_FIELDS = new Set(["latitude", "longitude", "max_draft_m", "experts_available"]);
const TEXT_FIELDS = ["port_name", "country", "region", "description", "psc_risk_level", ...ENRICHMENT_FIELDS.filter((field) => !JSON_FIELDS.has(field) && !NUMBER_FIELDS.has(field))];
const UNLOCODE = /^[A-Z]{2}[A-Z0-9]{3}$/;
const COUNTRY_ISO = /^[A-Z]{2}$/;

const cleanText = (value) => {
  if (value === undefined) return undefined;
  const clean = String(value ?? "").trim();
  return clean || undefined;
};

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

export function normalizePortPayload(body = {}, { partial = false } = {}) {
  const normalized = {};
  for (const field of TEXT_FIELDS) {
    const value = cleanText(body[field]);
    if (value !== undefined) normalized[field] = value;
  }
  if (normalized.unlocode) {
    normalized.unlocode = normalized.unlocode.toUpperCase();
    if (!UNLOCODE.test(normalized.unlocode)) throw badRequest("UNLOCODE must contain 5 uppercase letters or digits, beginning with a 2-letter country code");
    if (!normalized.country_iso) normalized.country_iso = normalized.unlocode.slice(0, 2);
  }
  if (normalized.country_iso) {
    normalized.country_iso = normalized.country_iso.toUpperCase();
    if (!COUNTRY_ISO.test(normalized.country_iso)) throw badRequest("country_iso must be a 2-letter code");
  }
  for (const field of NUMBER_FIELDS) {
    if (body[field] === undefined || body[field] === null || body[field] === "") continue;
    const value = Number(body[field]);
    if (!Number.isFinite(value)) throw badRequest(`${field} must be a valid number`);
    normalized[field] = value;
  }
  if (normalized.latitude != null && (normalized.latitude < -90 || normalized.latitude > 90)) throw badRequest("latitude must be between -90 and 90");
  if (normalized.longitude != null && (normalized.longitude < -180 || normalized.longitude > 180)) throw badRequest("longitude must be between -180 and 180");
  if (normalized.max_draft_m != null && normalized.max_draft_m < 0) throw badRequest("max_draft_m cannot be negative");
  for (const field of JSON_FIELDS) {
    if (body[field] === undefined) continue;
    if (!body[field] || typeof body[field] !== "object" || Array.isArray(body[field])) throw badRequest(`${field} must be an object`);
    if (Object.keys(body[field]).length) normalized[field] = body[field];
  }
  normalized.vessel_types = Array.isArray(body.vessel_types) ? [...new Set(body.vessel_types.map(cleanText).filter(Boolean))] : undefined;
  normalized.services = Array.isArray(body.services) ? [...new Set(body.services.map(cleanText).filter(Boolean))] : undefined;
  if (!partial && (!normalized.port_name || !normalized.country || !normalized.region)) throw badRequest("port_name, country and region are required");
  if (!partial) {
    normalized.psc_risk_level ??= "Medium";
    normalized.experts_available ??= 0;
  }
  return normalized;
}

export function buildPortListQuery(query = {}) {
  const compact = String(query.compact || "").toLowerCase() === "true";
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || (compact ? 50 : 25)));
  const conditions = ["p.is_active = true"];
  const values = [];
  const add = (sql, value) => { values.push(value); conditions.push(sql.replaceAll("?", `$${values.length}`)); };
  const search = cleanText(query.search);
  if (search) add("(p.port_name ILIKE '%' || ? || '%' OR p.country ILIKE '%' || ? || '%' OR p.unlocode ILIKE '%' || ? || '%')", search);
  if (cleanText(query.country)) add("LOWER(p.country)=LOWER(?)", cleanText(query.country));
  if (cleanText(query.region) && query.region !== "All Regions") add("LOWER(p.region)=LOWER(?)", cleanText(query.region));
  const harbourType = cleanText(query.harbourType ?? query.harbour_type);
  if (harbourType) add("LOWER(p.harbour_type)=LOWER(?)", harbourType);
  return { compact, page, limit, offset: (page - 1) * limit, where: conditions.join(" AND "), values };
}

const writeRelations = async (client, portId, vesselTypes, services) => {
  if (vesselTypes !== undefined) {
    await client.query("DELETE FROM port_vessel_types WHERE port_id=$1", [portId]);
    for (const type of vesselTypes) await client.query("INSERT INTO port_vessel_types (port_id,vessel_type) VALUES ($1,$2) ON CONFLICT (port_id,vessel_type) DO NOTHING", [portId, type]);
  }
  if (services !== undefined) {
    await client.query("DELETE FROM port_services WHERE port_id=$1", [portId]);
    for (const service of services) await client.query("INSERT INTO port_services (port_id,service_name) VALUES ($1,$2) ON CONFLICT (port_id,service_name) DO NOTHING", [portId, service]);
  }
};

export const createPort = async (req, res) => {
  const client = await pool.connect();
  try {
    const input = normalizePortPayload(req.body);
    await client.query("BEGIN");
    const columns = ["port_name", "country", "region"];
    const values = [input.port_name, input.country, input.region];
    for (const field of ["description", "psc_risk_level", "experts_available", ...ENRICHMENT_FIELDS]) {
      if (input[field] !== undefined) { columns.push(field); values.push(JSON_FIELDS.has(field) ? JSON.stringify(input[field]) : input[field]); }
    }
    const result = await client.query(`INSERT INTO ports (${columns.join(",")}) VALUES (${values.map((_, index) => `$${index + 1}`).join(",")}) RETURNING *`, values);
    await writeRelations(client, result.rows[0].id, input.vessel_types ?? [], input.services ?? []);
    await client.query("COMMIT");
    res.status(201).json({ success: true, message: "Port created successfully", port: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") return res.status(409).json({ message: "Port already exists for this country or UNLOCODE" });
    res.status(error.status || 500).json({ message: error.status ? error.message : "Failed to create port", ...(error.status ? {} : { error: error.message }) });
  } finally { client.release(); }
};

export const getPorts = async (req, res) => {
  try {
    const filters = buildPortListQuery(req.query);
    const listValues = [...filters.values, filters.limit, filters.offset];
    const fields = filters.compact
      ? "p.id,p.port_name,p.country,p.region,p.unlocode"
      : `p.id,p.port_name,p.country,p.country_iso,p.region,p.unlocode,p.harbour_type,p.harbour_size,p.max_draft_m,p.psc_risk_level,p.is_active,
         COALESCE((SELECT COUNT(DISTINCT ep.expert_id)::int FROM expert_ports ep WHERE LOWER(TRIM(ep.port_name))=LOWER(TRIM(p.port_name))),0) AS experts_available`;
    const data = await pool.query(`SELECT ${fields} FROM ports p WHERE ${filters.where} ORDER BY p.port_name,p.id LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`, listValues);
    if (filters.compact) return res.json({ success: true, message: "Ports fetched successfully", ports: data.rows });
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM ports p WHERE ${filters.where}`, filters.values);
    const total = count.rows[0]?.total || 0;
    res.json({ success: true, message: "Ports fetched successfully", ports: data.rows, pagination: { total, page: filters.page, limit: filters.limit, totalPages: Math.ceil(total / filters.limit) } });
  } catch (error) { res.status(500).json({ message: "Failed to fetch ports", error: error.message }); }
};

export const getPortById = async (req, res) => {
  try {
    const { id } = req.params;
    const portResult = await pool.query(`SELECT id,port_name,country,country_iso,unlocode,region,description,psc_risk_level,is_active,latitude,longitude,harbour_type,harbour_size,max_draft_m,depths,restrictions,equipment,navigation,communication,additional_attributes FROM ports WHERE id=$1 AND is_active=true`, [id]);
    if (!portResult.rows.length) return res.status(404).json({ message: "Port not found" });
    const port = portResult.rows[0];
    const [vessels, services, nearby, experts, directory] = await Promise.all([
      pool.query("SELECT vessel_type FROM port_vessel_types WHERE port_id=$1 ORDER BY vessel_type", [id]),
      pool.query("SELECT service_name FROM port_services WHERE port_id=$1 ORDER BY service_name", [id]),
      pool.query(`SELECT n.nearby_port_id,n.nearby_unlocode,n.nearby_port_name,n.latitude,n.longitude,n.distance_nm,COALESCE(p.port_name,n.nearby_port_name) AS port_name FROM port_nearby_ports n LEFT JOIN ports p ON p.id=n.nearby_port_id AND p.is_active=true WHERE n.port_id=$1 ORDER BY COALESCE(n.distance_nm,999999),n.nearby_port_name`, [id]),
      pool.query(`SELECT DISTINCT e.id,e.full_name,e.base_location,e.country,COALESCE(NULLIF(erd.discipline_other,''),erd.discipline) AS discipline,erd.photo_s3_key FROM expert_ports ep JOIN experts e ON e.id=ep.expert_id LEFT JOIN users u ON u.id=e.user_id LEFT JOIN expert_registration_details erd ON erd.expert_id=e.id WHERE LOWER(TRIM(ep.port_name))=LOWER(TRIM($1)) AND COALESCE(u.is_active,true)=true ORDER BY e.full_name`, [port.port_name]),
      port.unlocode ? pool.query(`SELECT DISTINCT e.id,e.company_name,e.slug,e.country,e.city,ARRAY(SELECT mt.directory_type FROM maritime_directory_entity_types mt WHERE mt.entity_id=e.id ORDER BY mt.directory_type) AS directory_types FROM maritime_directory_ports mp JOIN maritime_directory_entities e ON e.id=mp.entity_id WHERE UPPER(TRIM(mp.unlocode))=UPPER(TRIM($1)) AND e.is_active=true AND e.review_status='approved' ORDER BY e.company_name`, [port.unlocode]) : Promise.resolve({ rows: [] }),
    ]);
    const localExperts = experts.rows.map(({ photo_s3_key: key, ...expert }) => ({ ...expert, photo_url: key ? createPresignedGetUrl({ key }).url : null }));
    res.json({ success: true, message: "Port fetched successfully", port: { ...port, vessel_types: vessels.rows.map((row) => row.vessel_type), services: services.rows.map((row) => row.service_name), nearby_ports: nearby.rows, experts_available: localExperts.length, local_experts: localExperts, maritime_directory_entities: directory.rows } });
  } catch (error) { res.status(500).json({ message: "Failed to fetch port", error: error.message }); }
};

export const updatePort = async (req, res) => {
  const client = await pool.connect();
  try {
    const input = normalizePortPayload(req.body, { partial: true });
    const fields = ["port_name", "country", "region", "description", "psc_risk_level", "experts_available", ...ENRICHMENT_FIELDS].filter((field) => input[field] !== undefined);
    await client.query("BEGIN");
    let port;
    if (fields.length) {
      const values = fields.map((field) => JSON_FIELDS.has(field) ? JSON.stringify(input[field]) : input[field]);
      values.push(req.params.id);
      const result = await client.query(`UPDATE ports SET ${fields.map((field, index) => `${field}=$${index + 1}`).join(",")},updated_at=CURRENT_TIMESTAMP WHERE id=$${values.length} AND is_active=true RETURNING *`, values);
      port = result.rows[0];
    } else {
      port = (await client.query("SELECT * FROM ports WHERE id=$1 AND is_active=true", [req.params.id])).rows[0];
    }
    if (!port) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Port not found" }); }
    await writeRelations(client, port.id, input.vessel_types, input.services);
    await client.query("COMMIT");
    res.json({ success: true, message: "Port updated successfully", port });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") return res.status(409).json({ message: "Port already exists for this country or UNLOCODE" });
    res.status(error.status || 500).json({ message: error.status ? error.message : "Failed to update port", ...(error.status ? {} : { error: error.message }) });
  } finally { client.release(); }
};

export const deletePort = async (req, res) => {
  try {
    const result = await pool.query("UPDATE ports SET is_active=false,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND is_active=true RETURNING id", [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ message: "Port not found" });
    res.json({ success: true, message: "Port deactivated successfully" });
  } catch (error) { res.status(500).json({ message: "Failed to deactivate port", error: error.message }); }
};
