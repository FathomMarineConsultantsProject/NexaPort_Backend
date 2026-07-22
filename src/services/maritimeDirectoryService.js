import { pool } from "../config/db.js";
import { MARITIME_DIRECTORY_TABLES, MARITIME_DIRECTORY_TYPES } from "../config/maritimeDirectorySchema.js";
import { writeAdminAudit } from "./adminAuditService.js";

const T = MARITIME_DIRECTORY_TABLES;
const TYPE_SET = new Set(MARITIME_DIRECTORY_TYPES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (value) => String(value ?? "").trim();
const nullable = (value) => clean(value) || null;
const validationError = (fieldErrors) => Object.assign(new Error("Please correct the highlighted fields."), { status: 400, code: "MARITIME_DIRECTORY_VALIDATION_FAILED", fieldErrors });
const notFound = () => Object.assign(new Error("Directory entry not found."), { status: 404, code: "MARITIME_DIRECTORY_NOT_FOUND" });

const COMPANY_FIELDS = Object.freeze({
  companyName: "company_name", description: "description", logoUrl: "logo_url", country: "country", city: "city",
  publicAddress: "public_address", publicEmail: "public_email", publicPhone: "public_phone", website: "website",
  claimedStatus: "claimed_status", yearsExperience: "years_experience", vesselsHandled: "vessels_handled",
});

const COLLECTIONS = Object.freeze({
  services: { table: T.services, required: "serviceName", fields: { category: "category", serviceName: "service_name", serviceDescription: "service_description", serviceType: "service_type" } },
  ports: { table: T.ports, required: "portName", fields: { portName: "port_name", country: "country", unlocode: "unlocode", sourcePortText: "source_port_text" } },
  branches: { table: T.branches, required: "branchName", fields: { branchName: "branch_name", branchType: "branch_type", publicAddress: "public_address", city: "city", country: "country", publicTelephone: "public_telephone", publicEmail: "public_email" } },
  certifications: { table: T.certifications, required: "certificationName", fields: { certificationName: "certification_name", standardCode: "standard_code", issuer: "issuer", certificateImageUrl: "certificate_image_url", expiryDate: "expiry_date" } },
  classApprovals: { table: T.classApprovals, required: "societyName", fields: { societyName: "society_name", approvalDetails: "approval_details", logoUrl: "logo_url" } },
  memberships: { table: T.memberships, required: "organizationName", fields: { organizationName: "organization_name", membershipDetails: "membership_details", logoUrl: "logo_url" } },
  products: { table: T.products, required: "productName", fields: { category: "category", productName: "product_name", manufacturer: "manufacturer" } },
  faqs: { table: T.faqs, required: "question", fields: { question: "question", answer: "answer" }, alsoRequired: "answer" },
});

const normalizeWebsite = (value) => {
  const text = clean(value);
  if (!text) return null;
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`;
  const parsed = new URL(candidate);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid website");
  return parsed.toString();
};

const normalizeCompany = (input = {}, partial = false) => {
  const company = {};
  for (const [key, column] of Object.entries(COMPANY_FIELDS)) {
    if (!partial || Object.hasOwn(input, key)) company[column] = nullable(input[key]);
  }
  if (Object.hasOwn(company, "public_email")) company.public_email = company.public_email?.toLowerCase() || null;
  if (Object.hasOwn(company, "website") && company.website) {
    try { company.website = normalizeWebsite(company.website); } catch { company.website = "__invalid_url__"; }
  }
  for (const field of ["years_experience", "vessels_handled"]) {
    if (Object.hasOwn(company, field)) company[field] = company[field] == null ? null : Number(company[field]);
  }
  return company;
};

export const validateMaritimePayload = (payload, { partial = false } = {}) => {
  const errors = {};
  const company = normalizeCompany(payload?.company, partial);
  if (!partial && !company.company_name) errors["company.companyName"] = "Company name is required.";
  if (company.company_name !== undefined && (!company.company_name || company.company_name.length > 240)) errors["company.companyName"] = company.company_name ? "Company name must be 240 characters or fewer." : "Company name is required.";
  if (company.public_email && !EMAIL.test(company.public_email)) errors["company.publicEmail"] = "Enter a valid email address.";
  if (company.website === "__invalid_url__") errors["company.website"] = "Enter a valid http or https URL.";
  for (const field of ["years_experience", "vessels_handled"]) if (company[field] != null && (!Number.isInteger(company[field]) || company[field] < 0)) errors[`company.${field === "years_experience" ? "yearsExperience" : "vesselsHandled"}`] = "Enter a whole number of zero or more.";

  const types = payload?.directoryTypes;
  if (!partial || types !== undefined) {
    if (!Array.isArray(types) || !types.length) errors.directoryTypes = "Select at least one directory type.";
    else types.forEach((type, index) => { if (!TYPE_SET.has(type)) errors[`directoryTypes.${index}`] = "Unsupported directory type."; });
  }
  for (const [name, config] of Object.entries(COLLECTIONS)) {
    if (payload?.[name] === undefined && partial) continue;
    const rows = payload?.[name] ?? [];
    if (!Array.isArray(rows)) { errors[name] = "Must be an array."; continue; }
    if (rows.length > 250) errors[name] = "No more than 250 rows may be supplied.";
    rows.forEach((row, index) => {
      if (!clean(row?.[config.required])) errors[`${name}.${index}.${config.required}`] = "This field is required.";
      if (config.alsoRequired && !clean(row?.[config.alsoRequired])) errors[`${name}.${index}.${config.alsoRequired}`] = "This field is required.";
      if (row?.id != null && !UUID.test(String(row.id))) errors[`${name}.${index}.id`] = "Invalid row ID.";
    });
  }
  if (Object.keys(errors).length) throw validationError(errors);
  return { company, directoryTypes: types ? [...new Set(types)] : undefined };
};

const uniqueSlug = async (client, companyName, excludeId = null) => {
  const base = clean(companyName).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "directory-entry";
  for (let suffix = 0; suffix < 10000; suffix += 1) {
    const slug = suffix ? `${base}-${suffix + 1}` : base;
    const found = await client.query(`SELECT 1 FROM ${T.entities} WHERE slug=$1 AND ($2::uuid IS NULL OR id<>$2)`, [slug, excludeId]);
    if (!found.rows.length) return slug;
  }
  throw Object.assign(new Error("Unable to generate a unique directory slug."), { status: 409, code: "MARITIME_DIRECTORY_SLUG_CONFLICT" });
};

const replaceTypes = async (client, entityId, types) => {
  await client.query(`DELETE FROM ${T.entityTypes} WHERE entity_id=$1`, [entityId]);
  for (const type of types) await client.query(`INSERT INTO ${T.entityTypes} (entity_id,directory_type) VALUES ($1,$2)`, [entityId, type]);
};

const writeCollections = async (client, entityId, payload, partial = false) => {
  for (const [name, config] of Object.entries(COLLECTIONS)) {
    if (partial && payload[name] === undefined) continue;
    const rows = payload[name] || [];
    const retainedManualIds = rows.filter((row) => row.id).map((row) => row.id);
    await client.query(`DELETE FROM ${config.table} WHERE entity_id=$1 AND source_record_key IS NULL AND NOT (id = ANY($2::uuid[]))`, [entityId, retainedManualIds]);
    for (const row of rows) {
      const columns = Object.values(config.fields);
      const values = Object.keys(config.fields).map((key) => nullable(row[key]));
      if (row.id) {
        const result = await client.query(`UPDATE ${config.table} SET ${columns.map((column, index) => `${column}=$${index + 1}`).join(",")},updated_at=CURRENT_TIMESTAMP WHERE id=$${values.length + 1} AND entity_id=$${values.length + 2} RETURNING id`, [...values, row.id, entityId]);
        if (!result.rows.length) throw validationError({ [`${name}.id`]: "Row does not belong to this directory entry." });
      } else {
        await client.query(`INSERT INTO ${config.table} (entity_id,${columns.join(",")}) VALUES ($1,${columns.map((_, index) => `$${index + 2}`).join(",")})`, [entityId, ...values]);
      }
    }
  }
};

const detailQueries = Object.entries(COLLECTIONS).map(([name, config]) => [name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), `SELECT * FROM ${config.table} WHERE entity_id=$1 ORDER BY created_at,id`]);

export const getMaritimeEntity = async (entityId, queryable = pool) => {
  if (!UUID.test(String(entityId))) throw notFound();
  const entity = await queryable.query(`SELECT * FROM ${T.entities} WHERE id=$1`, [entityId]);
  if (!entity.rows.length) throw notFound();
  const types = await queryable.query(`SELECT directory_type FROM ${T.entityTypes} WHERE entity_id=$1 ORDER BY directory_type`, [entityId]);
  const result = { entity: entity.rows[0], directory_types: types.rows.map((row) => row.directory_type) };
  for (const [name, sql] of detailQueries) result[name] = (await queryable.query(sql, [entityId])).rows;
  return result;
};

export const listMaritimeEntities = async (query, queryable = pool) => {
  if (!TYPE_SET.has(query.type)) throw validationError({ type: "Select a supported directory type." });
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 20));
  const conditions = ["EXISTS (SELECT 1 FROM public.maritime_directory_entity_types mt WHERE mt.entity_id=e.id AND mt.directory_type=$1)"];
  const values = [query.type];
  const add = (sql, value) => { values.push(value); conditions.push(sql.replaceAll("?", `$${values.length}`)); };
  if (clean(query.search)) add(`(e.company_name ILIKE '%' || ? || '%' OR e.description ILIKE '%' || ? || '%' OR EXISTS (SELECT 1 FROM public.maritime_directory_services s WHERE s.entity_id=e.id AND s.service_name ILIKE '%' || ? || '%') OR EXISTS (SELECT 1 FROM public.maritime_directory_ports p WHERE p.entity_id=e.id AND p.port_name ILIKE '%' || ? || '%') OR EXISTS (SELECT 1 FROM public.maritime_directory_products p WHERE p.entity_id=e.id AND p.product_name ILIKE '%' || ? || '%'))`, clean(query.search));
  if (clean(query.country)) add("LOWER(e.country)=LOWER(?)", clean(query.country));
  if (clean(query.reviewStatus)) {
    if (!["pending", "approved", "rejected"].includes(query.reviewStatus)) throw validationError({ reviewStatus: "Unsupported review status." });
    add("e.review_status=?", query.reviewStatus);
  }
  if (query.isActive !== undefined && query.isActive !== "") {
    if (!["true", "false", true, false].includes(query.isActive)) throw validationError({ isActive: "Use true or false." });
    add("e.is_active=?", String(query.isActive) === "true");
  }
  const where = conditions.join(" AND ");
  const count = await queryable.query(`SELECT COUNT(*)::int AS total FROM ${T.entities} e WHERE ${where}`, values);
  values.push(limit, (page - 1) * limit);
  const data = await queryable.query(`SELECT e.id,e.company_name,e.slug,e.logo_url,e.country,e.city,e.public_email,e.public_phone,e.website,
    CASE WHEN length(coalesce(e.description,''))>180 THEN left(e.description,177)||'...' ELSE e.description END AS description_excerpt,
    ARRAY(SELECT mt.directory_type FROM ${T.entityTypes} mt WHERE mt.entity_id=e.id ORDER BY mt.directory_type) AS directory_types,
    e.review_status,e.is_active,e.data_source,e.created_at,e.updated_at,
    (SELECT COUNT(*)::int FROM ${T.services} s WHERE s.entity_id=e.id) AS service_count,
    (SELECT COUNT(*)::int FROM ${T.ports} p WHERE p.entity_id=e.id) AS port_count,
    (SELECT COUNT(*)::int FROM ${T.branches} b WHERE b.entity_id=e.id) AS branch_count
    FROM ${T.entities} e WHERE ${where} ORDER BY e.company_name,e.id LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  const total = count.rows[0].total;
  return { data: data.rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

export const createMaritimeEntity = async (payload, actorUserId, database = pool) => {
  const normalized = validateMaritimePayload(payload);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const slug = await uniqueSlug(client, normalized.company.company_name);
    const columns = Object.keys(normalized.company);
    const values = Object.values(normalized.company);
    const inserted = await client.query(`INSERT INTO ${T.entities} (${columns.join(",")},slug,data_source,review_status,created_by_user_id,updated_by_user_id) VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")},$${values.length + 1},'manual_admin','approved',$${values.length + 2},$${values.length + 2}) RETURNING id`, [...values, slug, actorUserId]);
    const entityId = inserted.rows[0].id;
    await replaceTypes(client, entityId, normalized.directoryTypes);
    await writeCollections(client, entityId, payload);
    await writeAdminAudit(client, { actorUserId, action: "maritime_directory_created", targetType: "maritime_directory_entity", targetId: entityId, summary: `Created directory entry; types: ${normalized.directoryTypes.join(", ")}` });
    await client.query("COMMIT");
    return await getMaritimeEntity(entityId, database);
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
};

export const updateMaritimeEntity = async (entityId, payload, actorUserId) => {
  if (!UUID.test(String(entityId))) throw notFound();
  const normalized = validateMaritimePayload(payload, { partial: true });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(`SELECT id,company_name FROM ${T.entities} WHERE id=$1 FOR UPDATE`, [entityId]);
    if (!locked.rows.length) throw notFound();
    const changed = [];
    if (Object.keys(normalized.company).length) {
      const entries = Object.entries(normalized.company);
      const values = entries.map(([, value]) => value);
      let slugSql = "";
      if (normalized.company.company_name && normalized.company.company_name !== locked.rows[0].company_name) { values.push(await uniqueSlug(client, normalized.company.company_name, entityId)); slugSql = `,slug=$${values.length}`; }
      values.push(actorUserId, entityId);
      await client.query(`UPDATE ${T.entities} SET ${entries.map(([column], index) => `${column}=$${index + 1}`).join(",")}${slugSql},updated_by_user_id=$${values.length - 1},updated_at=CURRENT_TIMESTAMP WHERE id=$${values.length}`, values);
      changed.push("company");
    }
    if (normalized.directoryTypes) { await replaceTypes(client, entityId, normalized.directoryTypes); changed.push("directory types"); }
    const collections = Object.keys(COLLECTIONS).filter((name) => payload[name] !== undefined);
    if (collections.length) { await writeCollections(client, entityId, payload, true); changed.push(...collections); }
    await writeAdminAudit(client, { actorUserId, action: "maritime_directory_updated", targetType: "maritime_directory_entity", targetId: entityId, summary: `Updated sections: ${changed.join(", ") || "none"}` });
    await client.query("COMMIT");
    return await getMaritimeEntity(entityId);
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
};

export const setMaritimeEntityState = async (entityId, action, actorUserId, reason = null) => {
  const actions = {
    approve: ["review_status", "approved", "maritime_directory_approved"],
    reject: ["review_status", "rejected", "maritime_directory_rejected"],
    activate: ["is_active", true, "maritime_directory_activated"],
    deactivate: ["is_active", false, "maritime_directory_deactivated"],
  };
  if (!UUID.test(String(entityId)) || !actions[action]) throw notFound();
  if (["reject", "deactivate"].includes(action) && !clean(reason)) throw validationError({ reason: "A reason is required." });
  const [column, value, auditAction] = actions[action];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(`UPDATE ${T.entities} SET ${column}=$1,updated_by_user_id=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$3 RETURNING id`, [value, actorUserId, entityId]);
    if (!updated.rows.length) throw notFound();
    const types = await client.query(`SELECT directory_type FROM ${T.entityTypes} WHERE entity_id=$1 ORDER BY directory_type`, [entityId]);
    await writeAdminAudit(client, { actorUserId, action: auditAction, targetType: "maritime_directory_entity", targetId: entityId, summary: `${action}; types: ${types.rows.map((row) => row.directory_type).join(", ")}`, reason: nullable(reason) });
    await client.query("COMMIT");
    return await getMaritimeEntity(entityId);
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
};
