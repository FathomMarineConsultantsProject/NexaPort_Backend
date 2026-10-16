import { createPresignedGetUrl } from "../utils/s3Presign.js";

export const INSPECTOR_TYPES = Object.freeze([
  "nexaport_consultant", "flag_inspector", "accredited_inspector", "appointed_surveyor",
]);
export const SURVEYOR_CATEGORIES = Object.freeze([
  "Marine Surveyors", "Maritime Consultants", "Flag State Inspectors",
  "Vessel Inspectors", "Accredited Inspectors", "Appointed Surveyors",
]);

const clean = (value, max = 160) => String(value || "").trim().slice(0, max);
const positive = (value, fallback, max) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

export const normalizeInspectorSearch = (input = {}) => {
  const type = clean(input.type, 40);
  if (type && !INSPECTOR_TYPES.includes(type)) {
    throw Object.assign(new Error("Unsupported inspector type"), { status: 400 });
  }
  const category = clean(input.category, 40);
  if (category && !SURVEYOR_CATEGORIES.includes(category)) {
    throw Object.assign(new Error("Unsupported Surveyor category"), { status: 400 });
  }
  const page = positive(input.page, 1, 100000);
  const limit = positive(input.limit, 25, 100);
  return {
    q: clean(input.q), country: clean(input.country), port: clean(input.port), type, category,
    discipline: clean(input.discipline), specialization: clean(input.specialization),
    inspectionType: clean(input.inspectionType), flagState: clean(input.flagState),
    accreditation: clean(input.accreditation), capability: clean(input.capability),
    humanOnly: input.humanOnly === true || input.humanOnly === "true", page, limit,
  };
};

export const buildInspectorSearchQuery = (filters) => {
  const { q, country, port, type, category, discipline, specialization, inspectionType, flagState, accreditation, capability, humanOnly, page, limit } = normalizeInspectorSearch(filters);
  const values = [`%${q}%`, q, `%${country}%`, type, `%${discipline}%`, flagState, limit, (page - 1) * limit,
    `%${port}%`, category, `%${specialization}%`, `%${inspectionType}%`, `%${accreditation}%`, `%${capability}%`, humanOnly];
  const sql = `
WITH inspector_records AS (
  SELECT e.id::text AS source_id,'nexaport_consultant'::text AS inspector_type,e.full_name AS name,
    erd.company_name AS organization,COALESCE(NULLIF(e.base_location,''),NULLIF(erd.city,''),e.country,erd.country) AS country_location,
    COALESCE(NULLIF(e.country,''),erd.country) AS country,COALESCE(NULLIF(erd.discipline_other,''),erd.discipline,
      (SELECT STRING_AGG(DISTINCT ms.name, ', ' ORDER BY ms.name) FROM expert_specialties es JOIN master_specialties ms ON ms.id=es.specialty_id WHERE es.expert_id=e.id)) AS discipline,
    erd.rank AS authority,(SELECT STRING_AGG(DISTINCT mfs.name, ', ' ORDER BY mfs.name) FROM expert_flags ef JOIN master_flag_states mfs ON mfs.id=ef.flag_id WHERE ef.expert_id=e.id AND ef.is_active=true) AS flag_state,
    erd.photo_s3_key AS image_key,'Nexaport'::text AS source_name,
    NULL::text AS source_url,
    (SELECT STRING_AGG(DISTINCT ep.port_name, ', ' ORDER BY ep.port_name) FROM expert_ports ep WHERE ep.expert_id=e.id) AS base_ports,
    e.years_experience::text AS experience,NULL::text AS scheme_slug,NULL::text AS flag_slug,
    COALESCE(e.public_id,e.nexaport_id) AS nexaport_id,
    ARRAY['Maritime Consultants']::text[] ||
      CASE WHEN (COALESCE(erd.discipline,'') || ' ' || COALESCE(erd.discipline_other,'') || ' ' ||
        COALESCE((SELECT STRING_AGG(ms.name,' ') FROM expert_specialties es JOIN master_specialties ms ON ms.id=es.specialty_id WHERE es.expert_id=e.id),'')) ~* 'survey'
        THEN ARRAY['Marine Surveyors']::text[] ELSE ARRAY[]::text[] END ||
      CASE WHEN EXISTS (SELECT 1 FROM expert_inspection_methods eim JOIN inspection_methods im ON im.id=eim.inspection_method_id WHERE eim.expert_id=e.id AND im.name ~* 'inspect')
        THEN ARRAY['Vessel Inspectors']::text[] ELSE ARRAY[]::text[] END AS categories,
    (SELECT STRING_AGG(DISTINCT ms.name,', ' ORDER BY ms.name) FROM expert_specialties es JOIN master_specialties ms ON ms.id=es.specialty_id WHERE es.expert_id=e.id) AS specialization,
    (SELECT STRING_AGG(DISTINCT im.name,', ' ORDER BY im.name) FROM expert_inspection_methods eim JOIN inspection_methods im ON im.id=eim.inspection_method_id WHERE eim.expert_id=e.id) AS inspection_types,
    COALESCE((SELECT STRING_AGG(accreditation_value,', ' ORDER BY accreditation_value) FROM jsonb_array_elements_text(COALESCE(erd.accreditations,'[]'::jsonb)) AS accreditation_values(accreditation_value)),erd.accreditations_other) AS accreditation,
    (SELECT STRING_AGG(DISTINCT im.name,', ' ORDER BY im.name) FROM expert_inspection_methods eim JOIN inspection_methods im ON im.id=eim.inspection_method_id WHERE eim.expert_id=e.id) AS capabilities,
    TRUE AS is_person
  FROM experts e LEFT JOIN users u ON u.id=e.user_id LEFT JOIN expert_registration_details erd ON erd.expert_id=e.id
  WHERE (u.id IS NULL OR u.is_active=true)
  UNION ALL
  SELECT fi.id::text,'flag_inspector',COALESCE(fi.full_name,fi.organization_name),fi.organization_name,
    COALESCE(NULLIF(fi.location,''),NULLIF(fi.region,''),fi.country),fi.country,fi.areas_covered_text,NULL,mfs.name,NULL,
    COALESCE(fi.source_name,'Flag Inspector Directory'),fi.source_record_url,NULL,NULL,NULL,
    LOWER(REGEXP_REPLACE(TRIM(mfs.name), '[^a-zA-Z0-9]+', '-', 'g')),
    fi.public_id,ARRAY['Flag State Inspectors']::text[],fi.areas_covered_text,NULL::text,NULL::text,NULL::text,
    NULLIF(BTRIM(fi.full_name),'') IS NOT NULL
  FROM flag_inspectors fi JOIN master_flag_states mfs ON mfs.id=fi.flag_id WHERE fi.is_active=true
  UNION ALL
  SELECT ai.id::text,'accredited_inspector',ai.full_name,NULL,ai.country,ai.country,acs.name,ai.rcms_status,NULL,NULL,
    COALESCE(ai.source_name,acs.source_name,'Accredited Inspectors Directory'),COALESCE(ai.source_url,acs.source_url),NULL,NULL,acs.slug,NULL,
    ai.public_id,ARRAY['Accredited Inspectors']::text[],acs.name,NULL::text,acs.name,NULL::text,
    NULLIF(BTRIM(ai.full_name),'') IS NOT NULL
  FROM accredited_inspectors ai JOIN accreditation_schemes acs ON acs.id=ai.scheme_id WHERE ai.is_active=true AND acs.is_active=true
  UNION ALL
  SELECT aps.id::text,'appointed_surveyor',COALESCE(aps.full_name,aps.organization_name),aps.organization_name,
    COALESCE(NULLIF(aps.address_text,''),aps.country),aps.country,aps.appointment_scope,aps.professional_title,NULL,NULL,
    COALESCE(aps.source_name,'Appointed Surveyors Directory'),NULL,NULL,NULL,NULL,NULL,
    aps.public_id,ARRAY['Appointed Surveyors']::text[],aps.appointment_scope,NULL::text,NULL::text,NULL::text,
    NULLIF(BTRIM(aps.full_name),'') IS NOT NULL
  FROM appointed_ship_surveyors aps WHERE aps.is_active=true
), filtered AS (
 SELECT *,CASE
   WHEN $2<>'' AND (LOWER(COALESCE(country,''))=LOWER($2) OR LOWER(COALESCE(country_location,''))=LOWER($2)) THEN 0
   WHEN $2<>'' AND LOWER(name)=LOWER($2) THEN 1
   WHEN $2<>'' AND LOWER(COALESCE(discipline,''))=LOWER($2) THEN 2 ELSE 3 END AS relevance
 FROM inspector_records
 WHERE ($4='' OR inspector_type=$4)
   AND ($15::boolean=FALSE OR is_person)
   AND ($10='' OR $10=ANY(categories))
   AND ($3='%%' OR COALESCE(country,'') ILIKE $3 OR COALESCE(country_location,'') ILIKE $3 OR COALESCE(base_ports,'') ILIKE $3)
   AND ($9='%%' OR COALESCE(base_ports,'') ILIKE $9)
   AND ($5='%%' OR COALESCE(discipline,'') ILIKE $5)
   AND ($11='%%' OR COALESCE(specialization,'') ILIKE $11)
   AND ($12='%%' OR COALESCE(inspection_types,'') ILIKE $12)
   AND ($13='%%' OR COALESCE(accreditation,'') ILIKE $13)
   AND ($14='%%' OR COALESCE(capabilities,'') ILIKE $14)
   AND ($6='' OR COALESCE(flag_state,'') ILIKE ('%' || $6 || '%'))
   AND ($1='%%' OR name ILIKE $1 OR COALESCE(organization,'') ILIKE $1 OR COALESCE(country,'') ILIKE $1
     OR COALESCE(country_location,'') ILIKE $1 OR COALESCE(base_ports,'') ILIKE $1 OR COALESCE(discipline,'') ILIKE $1
     OR COALESCE(authority,'') ILIKE $1 OR COALESCE(flag_state,'') ILIKE $1 OR COALESCE(specialization,'') ILIKE $1
     OR COALESCE(inspection_types,'') ILIKE $1 OR COALESCE(accreditation,'') ILIKE $1 OR nexaport_id=$2)
)
SELECT *,COUNT(*) OVER()::int AS total FROM filtered
ORDER BY relevance,name,inspector_type,source_id LIMIT $7 OFFSET $8`;
  return { sql, values, filters: { q, country, port, type, category, discipline, specialization, inspectionType, flagState, accreditation, capability, humanOnly, page, limit } };
};

const photoUrl = (key) => {
  if (!key) return null;
  try { return createPresignedGetUrl({ key, expiresInSeconds: 600 }).url; } catch { return null; }
};

export const searchInspectors = async (queryable, input = {}) => {
  const { sql, values, filters } = buildInspectorSearchQuery(input);
  const rows = (await queryable.query(sql, values)).rows;
  const total = Number(rows[0]?.total || 0);
  const items = rows.map(({ total: _total, relevance: _relevance, image_key: imageKey, ...row }) => ({
    ...row, photo_url: photoUrl(imageKey),
  }));
  return { items, total, page: filters.page, limit: filters.limit, totalPages: Math.ceil(total / filters.limit) };
};
