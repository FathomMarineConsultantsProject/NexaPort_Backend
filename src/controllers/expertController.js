import crypto from "crypto";
import { pool } from "../config/db.js";
import {
  createPresignedGetUrl,
  createPresignedPutUrl,
} from "../utils/s3Presign.js";

const EXPERT_PHOTO_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const EXPERT_PHOTO_MAX_BYTES = 3 * 1024 * 1024;
const EXPERT_CV_MAX_BYTES = 5 * 1024 * 1024;
const EXPERT_PHOTO_UPLOAD_EXPIRY_SECONDS = 300;
const GENERATED_MEDIA_SUFFIX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(img|pdf)$/i;
const flagSlugSql = "LOWER(REGEXP_REPLACE(TRIM(mfs.name), '[^a-zA-Z0-9]+', '-', 'g'))";

const normalizeSubmittedPorts = (ports) => {
  if (!Array.isArray(ports)) {
    const error = new Error("Ports must be an array");
    error.statusCode = 400;
    throw error;
  }

  const seen = new Set();
  const normalized = [];

  ports.forEach((port) => {
    if (typeof port !== "string") {
      const error = new Error("Ports must contain valid port names");
      error.statusCode = 400;
      throw error;
    }

    const clean = port.trim();
    if (!clean || clean.length > 200) {
      const error = new Error("Ports must contain valid port names");
      error.statusCode = 400;
      throw error;
    }

    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(clean);
    }
  });

  return normalized;
};

const validateCanonicalPorts = async (client, submittedPorts) => {
  const normalizedPorts = normalizeSubmittedPorts(submittedPorts);
  if (!normalizedPorts.length) return [];

  const normalizedNames = normalizedPorts.map((port) => port.toLowerCase());
  const result = await client.query(
    `
    SELECT port_name
    FROM ports
    WHERE is_active = true
      AND LOWER(TRIM(port_name)) = ANY($1::text[])
    `,
    [normalizedNames]
  );

  const canonicalByName = new Map(
    result.rows.map((row) => [row.port_name.trim().toLowerCase(), row.port_name])
  );

  if (canonicalByName.size !== normalizedNames.length) {
    const error = new Error("Every selected port must exist and be active");
    error.statusCode = 400;
    throw error;
  }

  return normalizedNames.map((name) => canonicalByName.get(name));
};

const optionalText = (value) => {
  if (value === undefined) return undefined;
  const clean = String(value ?? "").trim();
  return clean || null;
};

const requiredText = (value) => {
  if (value === undefined) return undefined;
  return String(value ?? "").trim();
};

const jsonValue = (value, fallback) => {
  if (value === undefined) return undefined;
  return JSON.stringify(value ?? fallback);
};

const updateRegistrationDetails = async (client, expertId, details = {}) => {
  if (!details || typeof details !== "object" || Array.isArray(details)) return;

  const existing = await client.query(
    `SELECT id FROM expert_registration_details WHERE expert_id = $1 LIMIT 1`,
    [expertId]
  );

  if (!existing.rows.length) return;

  const fieldMap = [
    ["phone_number", requiredText(details.phone_number)],
    ["mobile_number", optionalText(details.mobile_number)],
    ["nationality", requiredText(details.nationality)],
    ["employment_status", requiredText(details.employment_status)],
    ["company_name", optionalText(details.company_name)],
    ["dob_dd", requiredText(details.dob_dd)],
    ["dob_mm", requiredText(details.dob_mm)],
    ["dob_yyyy", requiredText(details.dob_yyyy)],
    ["year_started", optionalText(details.year_started)],
    ["heard_about", requiredText(details.heard_about)],
    ["street1", requiredText(details.street1)],
    ["street2", optionalText(details.street2)],
    ["city", requiredText(details.city)],
    ["postal_code", requiredText(details.postal_code)],
    ["country", requiredText(details.country)],
    ["state_region", requiredText(details.state_region)],
    ["discipline", requiredText(details.discipline)],
    ["rank", requiredText(details.rank)],
    ["discipline_other", optionalText(details.discipline_other)],
    ["rank_other", optionalText(details.rank_other)],
    ["qualifications_other", optionalText(details.qualifications_other)],
    ["vessel_types_other", optionalText(details.vessel_types_other)],
    ["shoreside_experience_other", optionalText(details.shoreside_experience_other)],
    ["surveying_experience_other", optionalText(details.surveying_experience_other)],
    [
      "vessel_type_surveying_experience_other",
      optionalText(details.vessel_type_surveying_experience_other),
    ],
    ["accreditations_other", optionalText(details.accreditations_other)],
    ["courses_completed_other", optionalText(details.courses_completed_other)],
    ["qualifications", jsonValue(details.qualifications, [])],
    [
      "experience_by_qualification",
      jsonValue(details.experience_by_qualification, {}),
    ],
    ["vessel_types", jsonValue(details.vessel_types, [])],
    ["shoreside_experience", jsonValue(details.shoreside_experience, [])],
    ["surveying_experience", jsonValue(details.surveying_experience, [])],
    [
      "vessel_type_surveying_experience",
      jsonValue(details.vessel_type_surveying_experience, []),
    ],
    ["accreditations", jsonValue(details.accreditations, [])],
    ["courses_completed", jsonValue(details.courses_completed, [])],
    ["refs", jsonValue(details.refs, [])],
    ["inspection_cost", requiredText(details.inspection_cost)],
    [
      "marketing_consent",
      details.marketing_consent === undefined ? undefined : Boolean(details.marketing_consent),
    ],
  ].filter(([, value]) => value !== undefined);

  if (!fieldMap.length) return;

  const setSql = fieldMap
    .map(([column], index) => `${column} = $${index + 1}`)
    .join(", ");
  const values = fieldMap.map(([, value]) => value);

  await client.query(
    `
    UPDATE expert_registration_details
    SET ${setSql}, updated_at = CURRENT_TIMESTAMP
    WHERE expert_id = $${values.length + 1}
    `,
    [...values, expertId]
  );
};

const getExpertFullData = async (expertId) => {
  const expertResult = await pool.query(`SELECT * FROM experts WHERE id = $1`, [
    expertId,
  ]);

  if (!expertResult.rows.length) return null;

  const [
    specialties,
    certifications,
    vesselTypes,
    languages,
    ports,
    registrationDetails,
    flagServices,
  ] =
    await Promise.all([
      pool.query(
        `
        SELECT ms.id, ms.name
        FROM expert_specialties es
        JOIN master_specialties ms ON ms.id = es.specialty_id
        WHERE es.expert_id = $1
        `,
        [expertId]
      ),
      pool.query(
        `
        SELECT mc.id, mc.name
        FROM expert_certifications ec
        JOIN master_certifications mc ON mc.id = ec.certification_id
        WHERE ec.expert_id = $1
        `,
        [expertId]
      ),
      pool.query(
        `
        SELECT mvt.id, mvt.name
        FROM expert_vessel_types evt
        JOIN master_vessel_types mvt ON mvt.id = evt.vessel_type_id
        WHERE evt.expert_id = $1
        `,
        [expertId]
      ),
      pool.query(
        `SELECT id, language_name FROM expert_languages WHERE expert_id = $1`,
        [expertId]
      ),
      pool.query(`SELECT id, port_name FROM expert_ports WHERE expert_id = $1`, [
        expertId,
      ]),
      pool.query(
        `SELECT * FROM expert_registration_details WHERE expert_id = $1 LIMIT 1`,
        [expertId]
      ),
      pool.query(
        `
        SELECT
          ef.flag_id,
          mfs.name AS flag_name,
          ${flagSlugSql} AS flag_slug,
          COALESCE(
            JSON_AGG(
              JSONB_BUILD_OBJECT(
                'country', efc.country,
                'region', efc.region,
                'location', efc.location,
                'coverage_note', efc.coverage_note
              )
              ORDER BY efc.country ASC, efc.region ASC, efc.location ASC
            ) FILTER (WHERE efc.id IS NOT NULL),
            '[]'
          ) AS coverage
        FROM expert_flags ef
        JOIN master_flag_states mfs ON mfs.id = ef.flag_id
        LEFT JOIN expert_flag_coverage efc
          ON efc.expert_flag_id = ef.id
          AND efc.is_active = true
        WHERE ef.expert_id = $1
          AND ef.is_active = true
        GROUP BY ef.flag_id, mfs.name
        ORDER BY mfs.name ASC
        `,
        [expertId]
      ),
    ]);

  const registrationRow = registrationDetails.rows[0] || null;
  const {
    photo_s3_key: photoS3Key,
    cv_s3_key: cvS3Key,
    ...safeRegistrationDetails
  } = registrationRow || {};
  const photo = photoS3Key
    ? createPresignedGetUrl({ key: photoS3Key })
    : null;

  return {
    ...expertResult.rows[0],
    specialties: specialties.rows,
    certifications: certifications.rows,
    vessel_types: vesselTypes.rows,
    languages: languages.rows,
    ports: ports.rows,
    flag_services: flagServices.rows,
    registration_details: registrationRow ? safeRegistrationDetails : null,
    photo_url: photo?.url || null,
    photo_expires_at: photo?.expiresAt || null,
    has_cv: Boolean(cvS3Key),
  };
};

const canAccessExpert = (user, expert) => {
  const roleId = Number(user.role_id);

  if (roleId === 1) return true;
  if (roleId === 2) return Number(expert.user_id) === Number(user.id);

  return false;
};

const getOrCreateMasterId = async (client, tableName, name) => {
  const cleanName = String(name || "").trim();
  if (!cleanName) return null;

  const found = await client.query(
    `SELECT id FROM ${tableName} WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [cleanName]
  );

  if (found.rows.length) return found.rows[0].id;

  const created = await client.query(
    `INSERT INTO ${tableName} (name) VALUES ($1) RETURNING id`,
    [cleanName]
  );

  return created.rows[0].id;
};

export const getAllExperts = async (req, res) => {
  try {
    const values = [];
    let whereSql = "";

    if (Number(req.user.role_id) === 2) {
      values.push(req.user.id);
      whereSql = `WHERE e.user_id = $1`;
    }

    const result = await pool.query(
      `
      SELECT 
        e.*,
        erd.photo_s3_key,
        erd.inspection_cost,
        COALESCE(
          JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', ms.id, 'name', ms.name))
          FILTER (WHERE ms.id IS NOT NULL), '[]'
        ) AS specialties,
        COALESCE(
          JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', mvt.id, 'name', mvt.name))
          FILTER (WHERE mvt.id IS NOT NULL), '[]'
        ) AS vessel_types,
        COALESCE(
          JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', mc.id, 'name', mc.name))
          FILTER (WHERE mc.id IS NOT NULL), '[]'
        ) AS certifications
      FROM experts e
      LEFT JOIN expert_registration_details erd ON erd.expert_id = e.id
      LEFT JOIN expert_specialties es ON es.expert_id = e.id
      LEFT JOIN master_specialties ms ON ms.id = es.specialty_id
      LEFT JOIN expert_vessel_types evt ON evt.expert_id = e.id
      LEFT JOIN master_vessel_types mvt ON mvt.id = evt.vessel_type_id
      LEFT JOIN expert_certifications ec ON ec.expert_id = e.id
      LEFT JOIN master_certifications mc ON mc.id = ec.certification_id
      ${whereSql}
      GROUP BY e.id, erd.photo_s3_key, erd.inspection_cost
      ORDER BY e.created_at DESC
      `,
      values
    );

    const experts = result.rows.map((row) => {
      const { photo_s3_key: photoS3Key, ...expert } = row;
      const photo = photoS3Key
        ? createPresignedGetUrl({ key: photoS3Key })
        : null;

      return {
        ...expert,
        photo_url: photo?.url || null,
        photo_expires_at: photo?.expiresAt || null,
      };
    });

    res.json({
      success: true,
      count: experts.length,
      data: experts,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch experts",
      error: error.message,
    });
  }
};

export const getExpertById = async (req, res) => {
  try {
    const expert = await getExpertFullData(req.params.id);

    if (!expert) {
      return res.status(404).json({
        success: false,
        message: "Expert not found",
      });
    }

    if (!canAccessExpert(req.user, expert)) {
      return res.status(403).json({
        success: false,
        message: "Access denied for this expert profile",
      });
    }

    res.json({
      success: true,
      data: expert,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch expert",
      error: error.message,
    });
  }
};

const getExpertPhotoUpdateTarget = async (expertId) => {
  const result = await pool.query(
    `
    SELECT e.id, e.user_id, erd.id AS registration_details_id
    FROM experts e
    LEFT JOIN expert_registration_details erd ON erd.expert_id = e.id
    WHERE e.id = $1
    LIMIT 1
    `,
    [expertId]
  );

  return result.rows[0] || null;
};

const validateExpertMediaKey = (key, kind, expertId) => {
  if (typeof key !== "string" || !key.trim()) return false;

  const cleanKey = key.trim();
  const extension = kind === "photo" ? "img" : "pdf";
  const prefix = `consultant-registrations/${
    kind === "photo" ? "photos" : "cvs"
  }/${expertId}/`;
  const suffix = cleanKey.slice(prefix.length);

  return (
    !cleanKey.includes("..") &&
    !cleanKey.includes("\\") &&
    cleanKey.startsWith(prefix) &&
    GENERATED_MEDIA_SUFFIX.test(suffix) &&
    suffix.toLowerCase().endsWith(`.${extension}`)
  );
};

export const createExpertMediaUploadUrl = async (req, res) => {
  try {
    const expertId = Number(req.params.id);
    if (!Number.isInteger(expertId) || expertId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid expert ID" });
    }

    const expert = await getExpertPhotoUpdateTarget(expertId);
    if (!expert) {
      return res.status(404).json({ success: false, message: "Expert not found" });
    }
    if (!canAccessExpert(req.user, expert)) {
      return res.status(403).json({
        success: false,
        message: "Access denied for this expert profile",
      });
    }
    if (!expert.registration_details_id) {
      return res.status(409).json({
        success: false,
        message: "Profile media update is not available for this consultant",
      });
    }

    const { kind, contentType, size } = req.body || {};
    const byteSize = Number(size);
    if (kind !== "photo" && kind !== "cv") {
      return res.status(400).json({ success: false, message: "Invalid media kind" });
    }
    if (!Number.isFinite(byteSize) || byteSize <= 0) {
      return res.status(400).json({ success: false, message: "File size is required" });
    }
    if (kind === "photo" && !EXPERT_PHOTO_TYPES.has(contentType)) {
      return res.status(400).json({
        success: false,
        message: "Photo must be PNG, JPEG or WEBP",
      });
    }
    if (kind === "photo" && byteSize > EXPERT_PHOTO_MAX_BYTES) {
      return res.status(400).json({ success: false, message: "Photo must be 3MB or less" });
    }
    if (kind === "cv" && contentType !== "application/pdf") {
      return res.status(400).json({ success: false, message: "CV must be PDF" });
    }
    if (kind === "cv" && byteSize > EXPERT_CV_MAX_BYTES) {
      return res.status(400).json({ success: false, message: "CV must be 5MB or less" });
    }

    const folder = kind === "photo" ? "photos" : "cvs";
    const extension = kind === "photo" ? "img" : "pdf";
    const key = `consultant-registrations/${folder}/${expertId}/${crypto.randomUUID()}.${extension}`;
    const uploadUrl = createPresignedPutUrl({ key, contentType });

    return res.json({ success: true, uploadUrl, key });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to create profile media upload URL",
    });
  }
};

export const createExpertPhotoUploadUrl = async (req, res) => {
  try {
    const expertId = Number(req.params.id);
    if (!Number.isInteger(expertId) || expertId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid expert ID",
      });
    }

    const expert = await getExpertPhotoUpdateTarget(expertId);
    if (!expert) {
      return res.status(404).json({
        success: false,
        message: "Expert not found",
      });
    }

    if (Number(expert.user_id) !== Number(req.user.id)) {
      return res.status(403).json({
        success: false,
        message: "Access denied for this expert profile",
      });
    }

    if (!expert.registration_details_id) {
      return res.status(409).json({
        success: false,
        message: "Profile photo update is not available for this consultant",
      });
    }

    const { contentType, size } = req.body || {};
    const byteSize = Number(size);

    if (!EXPERT_PHOTO_TYPES.has(contentType)) {
      return res.status(400).json({
        success: false,
        message: "Photo must be PNG, JPEG or WEBP",
      });
    }

    if (!Number.isFinite(byteSize) || byteSize <= 0) {
      return res.status(400).json({
        success: false,
        message: "File size is required",
      });
    }

    if (byteSize > EXPERT_PHOTO_MAX_BYTES) {
      return res.status(400).json({
        success: false,
        message: "Photo must be 3MB or less",
      });
    }

    const key = `consultant-registrations/photos/${expertId}/${crypto.randomUUID()}.img`;
    const uploadUrl = createPresignedPutUrl({ key, contentType });

    return res.json({
      success: true,
      uploadUrl,
      key,
      expiresAt: new Date(
        Date.now() + EXPERT_PHOTO_UPLOAD_EXPIRY_SECONDS * 1000
      ).toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to create profile photo upload URL",
    });
  }
};

export const updateExpertPhoto = async (req, res) => {
  try {
    const expertId = Number(req.params.id);
    if (!Number.isInteger(expertId) || expertId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid expert ID",
      });
    }

    const expert = await getExpertPhotoUpdateTarget(expertId);
    if (!expert) {
      return res.status(404).json({
        success: false,
        message: "Expert not found",
      });
    }

    if (Number(expert.user_id) !== Number(req.user.id)) {
      return res.status(403).json({
        success: false,
        message: "Access denied for this expert profile",
      });
    }

    if (!expert.registration_details_id) {
      return res.status(409).json({
        success: false,
        message: "Profile photo update is not available for this consultant",
      });
    }

    const photoS3Key =
      typeof req.body?.photoS3Key === "string"
        ? req.body.photoS3Key.trim()
        : "";
    const expectedPrefix = `consultant-registrations/photos/${expertId}/`;
    const keySuffix = photoS3Key.slice(expectedPrefix.length);
    const validGeneratedSuffix =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.img$/i;

    if (
      !photoS3Key ||
      photoS3Key.includes("..") ||
      photoS3Key.includes("\\") ||
      !photoS3Key.startsWith(expectedPrefix) ||
      !validGeneratedSuffix.test(keySuffix)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid profile photo key",
      });
    }

    await pool.query(
      `
      UPDATE expert_registration_details
      SET photo_s3_key = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE expert_id = $2
      `,
      [photoS3Key, expertId]
    );

    const photo = createPresignedGetUrl({ key: photoS3Key });

    return res.json({
      success: true,
      photo_url: photo.url,
      photo_expires_at: photo.expiresAt,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update profile photo",
    });
  }
};

export const getExpertCvUrl = async (req, res) => {
  try {
    const expertId = Number(req.params.id);
    if (!Number.isInteger(expertId) || expertId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid expert ID",
      });
    }

    const result = await pool.query(
      `
      SELECT cv_s3_key
      FROM expert_registration_details
      WHERE expert_id = $1
      LIMIT 1
      `,
      [expertId]
    );
    const cvS3Key = result.rows[0]?.cv_s3_key;

    if (!cvS3Key) {
      return res.status(404).json({
        success: false,
        message: "CV not found",
      });
    }

    const cv = createPresignedGetUrl({
      key: cvS3Key,
      expiresInSeconds: 600,
    });

    return res.json({
      success: true,
      url: cv.url,
      expiresAt: cv.expiresAt,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to create CV access URL",
    });
  }
};

export const createExpert = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      full_name,
      biography,
      base_location,
      country,
      day_rate_usd,
      years_experience,
      availability,
      is_premium,
      specialty_ids = [],
      certification_ids = [],
      vessel_type_ids = [],
      ports = [],
      languages = [],
      user_id,
    } = req.body;

    if (!full_name) {
      return res.status(400).json({
        success: false,
        message: "full_name is required",
      });
    }

    const expertUserId =
      Number(req.user.role_id) === 1 ? user_id || null : req.user.id;

    if (Number(req.user.role_id) === 2) {
      const existing = await pool.query(
        `SELECT id FROM experts WHERE user_id = $1`,
        [req.user.id]
      );

      if (existing.rows.length) {
        return res.status(409).json({
          success: false,
          message: "Expert profile already exists for this user",
        });
      }
    }

    await client.query("BEGIN");

    const expertResult = await client.query(
      `
      INSERT INTO experts (
        user_id,
        full_name,
        biography,
        base_location,
        country,
        day_rate_usd,
        years_experience,
        availability,
        is_premium
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
      `,
      [
        expertUserId,
        full_name,
        biography || null,
        base_location || null,
        country || null,
        day_rate_usd || null,
        years_experience || null,
        availability || "available",
        is_premium || false,
      ]
    );

    const expert = expertResult.rows[0];

    for (const specialtyId of specialty_ids) {
      await client.query(
        `INSERT INTO expert_specialties (expert_id, specialty_id) VALUES ($1, $2)`,
        [expert.id, specialtyId]
      );
    }

    for (const certificationId of certification_ids) {
      await client.query(
        `INSERT INTO expert_certifications (expert_id, certification_id) VALUES ($1, $2)`,
        [expert.id, certificationId]
      );
    }

    for (const vesselTypeId of vessel_type_ids) {
      await client.query(
        `INSERT INTO expert_vessel_types (expert_id, vessel_type_id) VALUES ($1, $2)`,
        [expert.id, vesselTypeId]
      );
    }

    for (const portName of ports) {
      await client.query(
        `INSERT INTO expert_ports (expert_id, port_name) VALUES ($1, $2)`,
        [expert.id, portName]
      );
    }

    for (const languageName of languages) {
      await client.query(
        `INSERT INTO expert_languages (expert_id, language_name) VALUES ($1, $2)`,
        [expert.id, languageName]
      );
    }

    await client.query("COMMIT");

    const fullExpert = await getExpertFullData(expert.id);

    res.status(201).json({
      success: true,
      message: "Expert created successfully",
      data: fullExpert,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    res.status(500).json({
      success: false,
      message: "Failed to create expert",
      error: error.message,
    });
  } finally {
    client.release();
  }
};

export const updateExpert = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    const existing = await client.query(`SELECT * FROM experts WHERE id = $1`, [
      id,
    ]);

    if (!existing.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Expert not found",
      });
    }

    if (!canAccessExpert(req.user, existing.rows[0])) {
      return res.status(403).json({
        success: false,
        message: "Only admin or profile owner can update this expert",
      });
    }

    const {
      full_name,
      biography,
      base_location,
      country,
      day_rate_usd,
      years_experience,
      availability,
      is_premium,
      specialty_ids,
      certification_ids,
      vessel_type_ids,
      specialties,
      certifications,
      vessel_types,
      ports,
      languages,
      registration_details,
      photo_s3_key,
      cv_s3_key,
    } = req.body;

    if (
      photo_s3_key !== undefined &&
      !validateExpertMediaKey(photo_s3_key, "photo", id)
    ) {
      const error = new Error("Invalid profile photo key");
      error.statusCode = 400;
      throw error;
    }
    if (
      cv_s3_key !== undefined &&
      !validateExpertMediaKey(cv_s3_key, "cv", id)
    ) {
      const error = new Error("Invalid CV key");
      error.statusCode = 400;
      throw error;
    }

    const canonicalPorts = ports !== undefined ? await validateCanonicalPorts(client, ports) : null;

    await client.query("BEGIN");

    if (photo_s3_key !== undefined || cv_s3_key !== undefined) {
      const registration = await client.query(
        `SELECT id FROM expert_registration_details WHERE expert_id = $1 LIMIT 1`,
        [id]
      );
      if (!registration.rows.length) {
        const error = new Error(
          "Profile media update is not available for this consultant"
        );
        error.statusCode = 409;
        throw error;
      }

      const mediaFields = [];
      const mediaValues = [];
      if (photo_s3_key !== undefined) {
        mediaValues.push(photo_s3_key.trim());
        mediaFields.push(`photo_s3_key = $${mediaValues.length}`);
      }
      if (cv_s3_key !== undefined) {
        mediaValues.push(cv_s3_key.trim());
        mediaFields.push(`cv_s3_key = $${mediaValues.length}`);
      }
      mediaValues.push(id);
      await client.query(
        `UPDATE expert_registration_details
         SET ${mediaFields.join(", ")}, updated_at = CURRENT_TIMESTAMP
         WHERE expert_id = $${mediaValues.length}`,
        mediaValues
      );
    }

    const finalSpecialtyIds = Array.isArray(specialties)
      ? (await Promise.all(
        specialties.map((name) =>
          getOrCreateMasterId(client, "master_specialties", name)
        )
      )).filter(Boolean)
      : specialty_ids;

    const finalCertificationIds = Array.isArray(certifications)
      ? (await Promise.all(
        certifications.map((name) =>
          getOrCreateMasterId(client, "master_certifications", name)
        )
      )).filter(Boolean)
      : certification_ids;

    const finalVesselTypeIds = Array.isArray(vessel_types)
      ? (await Promise.all(
        vessel_types.map((name) =>
          getOrCreateMasterId(client, "master_vessel_types", name)
        )
      )).filter(Boolean)
      : vessel_type_ids;

    const result = await client.query(
      `
      UPDATE experts
      SET
        full_name = COALESCE($1, full_name),
        biography = COALESCE($2, biography),
        base_location = COALESCE($3, base_location),
        country = COALESCE($4, country),
        day_rate_usd = COALESCE($5, day_rate_usd),
        years_experience = COALESCE($6, years_experience),
        availability = COALESCE($7, availability),
        is_premium = COALESCE($8, is_premium),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $9
      RETURNING *
      `,
      [
        full_name,
        biography,
        base_location,
        country,
        day_rate_usd,
        years_experience,
        availability,
        is_premium,
        id,
      ]
    );

    if (Array.isArray(finalSpecialtyIds)) {
      await client.query(`DELETE FROM expert_specialties WHERE expert_id = $1`, [
        id,
      ]);

      for (const specialtyId of finalSpecialtyIds) {
        await client.query(
          `INSERT INTO expert_specialties (expert_id, specialty_id) VALUES ($1, $2)`,
          [id, specialtyId]
        );
      }
    }

    if (Array.isArray(finalCertificationIds)) {
      await client.query(
        `DELETE FROM expert_certifications WHERE expert_id = $1`,
        [id]
      );

      for (const certificationId of finalCertificationIds) {
        await client.query(
          `INSERT INTO expert_certifications (expert_id, certification_id) VALUES ($1, $2)`,
          [id, certificationId]
        );
      }
    }

    if (Array.isArray(finalVesselTypeIds)) {
      await client.query(
        `DELETE FROM expert_vessel_types WHERE expert_id = $1`,
        [id]
      );

      for (const vesselTypeId of finalVesselTypeIds) {
        await client.query(
          `INSERT INTO expert_vessel_types (expert_id, vessel_type_id) VALUES ($1, $2)`,
          [id, vesselTypeId]
        );
      }
    }

    if (Array.isArray(ports)) {
      await client.query(`DELETE FROM expert_ports WHERE expert_id = $1`, [id]);

      for (const portName of canonicalPorts) {
        await client.query(
          `INSERT INTO expert_ports (expert_id, port_name) VALUES ($1, $2)`,
          [id, portName]
        );
      }
    }

    await updateRegistrationDetails(client, id, registration_details);

    if (Array.isArray(languages)) {
      await client.query(`DELETE FROM expert_languages WHERE expert_id = $1`, [
        id,
      ]);

      for (const languageName of languages) {
        await client.query(
          `INSERT INTO expert_languages (expert_id, language_name) VALUES ($1, $2)`,
          [id, languageName]
        );
      }
    }

    await client.query("COMMIT");

    const fullExpert = await getExpertFullData(result.rows[0].id);

    res.json({
      success: true,
      message: "Expert updated successfully",
      data: fullExpert,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : "Failed to update expert",
      error: error.message,
    });
  } finally {
    client.release();
  }
};

export const deleteExpert = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `DELETE FROM experts WHERE id = $1 RETURNING *`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Expert not found",
      });
    }

    res.json({
      success: true,
      message: "Expert deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete expert",
      error: error.message,
    });
  }
};
