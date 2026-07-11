import { pool } from "../config/db.js";

const mapScheme = (row) => ({
  id: row.id,
  code: row.code,
  slug: row.slug,
  name: row.name,
  description: row.description,
  source_name: row.source_name,
  source_url: row.source_url,
});

const mapDirectoryScheme = (row) => ({
  code: row.code,
  slug: row.slug,
  name: row.name,
  description: row.description,
  source_name: row.source_name,
  source_url: row.source_url,
});

const getActiveScheme = async (schemeSlug) => {
  const result = await pool.query(
    `
    SELECT id, code, slug, name, description, source_name, source_url
    FROM public.accreditation_schemes
    WHERE LOWER(slug) = LOWER($1)
      AND is_active = true
    LIMIT 1
    `,
    [schemeSlug]
  );

  return result.rows[0] || null;
};

export const getAccreditationSchemes = async (_req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, code, slug, name, description, source_name, source_url
      FROM public.accreditation_schemes
      WHERE is_active = true
      ORDER BY LOWER(name) ASC, id ASC
      `
    );

    return res.json({
      success: true,
      schemes: result.rows.map(mapScheme),
    });
  } catch (error) {
    console.error("Failed to fetch accreditation schemes", {
      name: error?.name,
      code: error?.code,
    });
    return res.status(500).json({
      success: false,
      message: "Failed to fetch accreditation schemes",
    });
  }
};

export const getAccreditedInspectors = async (req, res) => {
  try {
    const scheme = await getActiveScheme(String(req.params.schemeSlug || "").trim());

    if (!scheme) {
      return res.status(404).json({
        success: false,
        message: "Accreditation scheme not found",
      });
    }

    const search = String(req.query.search || "").trim();
    const country = String(req.query.country || "").trim();
    const rcms = String(req.query.rcms || "").trim();
    const values = [scheme.id];
    const conditions = ["ai.scheme_id = $1", "ai.is_active = true"];

    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(
        ai.full_name ILIKE $${values.length}
        OR ai.country ILIKE $${values.length}
        OR ai.email ILIKE $${values.length}
        OR ai.telephone ILIKE $${values.length}
      )`);
    }

    if (country) {
      values.push(country);
      conditions.push(`LOWER(TRIM(ai.country)) = LOWER(TRIM($${values.length}))`);
    }

    if (rcms) {
      values.push(rcms);
      conditions.push(`LOWER(TRIM(ai.rcms_status)) = LOWER(TRIM($${values.length}))`);
    }

    const [inspectorResult, countryResult, rcmsResult] = await Promise.all([
      pool.query(
        `
        SELECT
          ai.id,
          ai.full_name,
          ai.rcms_status,
          ai.telephone,
          ai.email,
          ai.country,
          ai.source_name,
          ai.source_url,
          ai.source_last_checked_at
        FROM public.accredited_inspectors ai
        WHERE ${conditions.join("\n          AND ")}
        ORDER BY LOWER(ai.full_name) ASC, LOWER(ai.country) ASC, ai.id ASC
        `,
        values
      ),
      pool.query(
        `
        SELECT country
        FROM public.accredited_inspectors
        WHERE scheme_id = $1
          AND is_active = true
          AND NULLIF(TRIM(country), '') IS NOT NULL
        GROUP BY country
        ORDER BY LOWER(country) ASC, country ASC
        `,
        [scheme.id]
      ),
      pool.query(
        `
        SELECT rcms_status
        FROM public.accredited_inspectors
        WHERE scheme_id = $1
          AND is_active = true
          AND NULLIF(TRIM(rcms_status), '') IS NOT NULL
        GROUP BY rcms_status
        ORDER BY LOWER(rcms_status) ASC, rcms_status ASC
        `,
        [scheme.id]
      ),
    ]);

    const inspectors = inspectorResult.rows.map((row) => ({
      id: row.id,
      full_name: row.full_name,
      rcms_status: row.rcms_status,
      telephone: row.telephone,
      email: row.email,
      country: row.country,
      record_type: "external",
      source_name: row.source_name,
      source_url: row.source_url,
      source_last_checked_at: row.source_last_checked_at,
    }));

    return res.json({
      success: true,
      scheme: mapDirectoryScheme(scheme),
      summary: {
        inspector_count: inspectors.length,
        country_count: new Set(inspectors.map((item) => item.country)).size,
      },
      filters: {
        countries: countryResult.rows.map((row) => row.country),
        rcms_statuses: rcmsResult.rows.map((row) => row.rcms_status),
      },
      inspectors,
    });
  } catch (error) {
    console.error("Failed to fetch accredited inspectors", {
      name: error?.name,
      code: error?.code,
    });
    return res.status(500).json({
      success: false,
      message: "Failed to fetch accredited inspectors",
    });
  }
};
