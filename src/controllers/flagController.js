import { pool } from "../config/db.js";
import { createPresignedGetUrl } from "../utils/s3Presign.js";

const flagSlugSql = "LOWER(REGEXP_REPLACE(TRIM(name), '[^a-zA-Z0-9]+', '-', 'g'))";

const toSlug = (name = "") =>
  String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const mapFlag = (row) => ({
  id: row.id,
  name: row.name,
  slug: row.slug || toSlug(row.name),
});

const getFlagBySlug = async (slug) => {
  const result = await pool.query(
    `
    SELECT id, name, ${flagSlugSql} AS slug
    FROM master_flag_states
    WHERE ${flagSlugSql} = $1
    LIMIT 1
    `,
    [slug]
  );

  return result.rows[0] || null;
};

const maybePhotoUrl = (photoS3Key) => {
  if (!photoS3Key) return null;

  try {
    return createPresignedGetUrl({ key: photoS3Key }).url;
  } catch {
    return null;
  }
};

export const getFlags = async (_req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, name, ${flagSlugSql} AS slug
      FROM master_flag_states
      ORDER BY name ASC
      `
    );

    res.json({
      success: true,
      flags: result.rows.map(mapFlag),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch flags",
      error: error.message,
    });
  }
};

export const getFlagDirectory = async (req, res) => {
  try {
    const flag = await getFlagBySlug(req.params.flagSlug);

    if (!flag) {
      return res.status(404).json({
        success: false,
        message: "Flag not found",
      });
    }

    const search = String(req.query.search || "").trim();
    const externalValues = [flag.id];
    const expertValues = [flag.id];
    let externalSearchSql = "";
    let expertSearchSql = "";

    if (search) {
      externalValues.push(`%${search}%`);
      externalSearchSql = `
        AND (
          fi.full_name ILIKE $${externalValues.length}
          OR fi.organization_name ILIKE $${externalValues.length}
          OR fi.country ILIKE $${externalValues.length}
          OR fi.region ILIKE $${externalValues.length}
          OR fi.location ILIKE $${externalValues.length}
          OR fi.areas_covered_text ILIKE $${externalValues.length}
        )
      `;

      expertValues.push(`%${search}%`);
      expertSearchSql = `
        AND (
          e.full_name ILIKE $${expertValues.length}
          OR e.country ILIKE $${expertValues.length}
          OR e.base_location ILIKE $${expertValues.length}
          OR efc.country ILIKE $${expertValues.length}
          OR efc.region ILIKE $${expertValues.length}
          OR efc.location ILIKE $${expertValues.length}
          OR efc.coverage_note ILIKE $${expertValues.length}
        )
      `;
    }

    const [externalResult, expertResult] = await Promise.all([
      pool.query(
        `
        SELECT
          fi.id,
          fi.full_name,
          fi.organization_name,
          fi.country,
          fi.region,
          fi.location,
          fi.areas_covered_text,
          fi.inspector_email,
          fi.inspector_telephone
        FROM flag_inspectors fi
        WHERE fi.flag_id = $1
          AND fi.is_active = true
          ${externalSearchSql}
        ORDER BY fi.country ASC, fi.location ASC, fi.full_name ASC
        `,
        externalValues
      ),
      pool.query(
        `
        SELECT
          e.id AS expert_id,
          e.full_name,
          e.country,
          e.base_location,
          erd.photo_s3_key,
          COALESCE(
            JSON_AGG(
              DISTINCT JSONB_BUILD_OBJECT(
                'country', efc.country,
                'region', efc.region,
                'location', efc.location,
                'coverage_note', efc.coverage_note
              )
            ) FILTER (WHERE efc.id IS NOT NULL),
            '[]'
          ) AS coverage
        FROM expert_flags ef
        JOIN experts e ON e.id = ef.expert_id
        LEFT JOIN expert_flag_coverage efc
          ON efc.expert_flag_id = ef.id
          AND efc.is_active = true
        LEFT JOIN expert_registration_details erd ON erd.expert_id = e.id
        WHERE ef.flag_id = $1
          AND ef.is_active = true
          ${expertSearchSql}
        GROUP BY e.id, erd.photo_s3_key
        ORDER BY e.country ASC, e.base_location ASC, e.full_name ASC
        `,
        expertValues
      ),
    ]);

    const externalRecords = externalResult.rows.map((row) => ({
      id: row.id,
      record_type: "external",
      full_name: row.full_name,
      organization_name: row.organization_name,
      country: row.country,
      region: row.region,
      location: row.location,
      areas_covered_text: row.areas_covered_text,
      inspector_email: row.inspector_email,
      inspector_telephone: row.inspector_telephone,
    }));

    const expertRecords = expertResult.rows.map((row) => ({
      expert_id: row.expert_id,
      record_type: "nexaport",
      full_name: row.full_name,
      country: row.country,
      base_location: row.base_location,
      photo_url: maybePhotoUrl(row.photo_s3_key),
      coverage: row.coverage || [],
    }));

    res.json({
      success: true,
      flag: mapFlag(flag),
      records: [...externalRecords, ...expertRecords],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch flag directory",
      error: error.message,
    });
  }
};

export const getFlagInspector = async (req, res) => {
  try {
    const flag = await getFlagBySlug(req.params.flagSlug);

    if (!flag) {
      return res.status(404).json({
        success: false,
        message: "Flag not found",
      });
    }

    const result = await pool.query(
      `
      SELECT
        fi.id,
        fi.full_name,
        fi.organization_name,
        fi.organization_address,
        fi.organization_email,
        fi.organization_telephone,
        fi.organization_fax,
        fi.inspector_email,
        fi.inspector_telephone,
        fi.country,
        fi.region,
        fi.location,
        fi.areas_covered_text,
        fi.source_name,
        fi.source_url,
        fi.source_record_url
      FROM flag_inspectors fi
      WHERE fi.id = $1
        AND fi.flag_id = $2
        AND fi.is_active = true
      LIMIT 1
      `,
      [req.params.inspectorId, flag.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Flag inspector not found",
      });
    }

    res.json({
      success: true,
      flag: mapFlag(flag),
      inspector: result.rows[0],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch flag inspector",
      error: error.message,
    });
  }
};
