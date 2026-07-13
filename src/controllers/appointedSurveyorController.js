import { pool } from "../config/db.js";

const ALLOWED_SCOPES = new Set(["general", "restricted"]);
const ALLOWED_MLC_VALUES = new Set(["true", "false"]);

const mapSurveyor = (row) => ({
  id: row.id,
  professional_title: row.professional_title,
  full_name: row.full_name,
  organization_name: row.organization_name,
  address_text: row.address_text,
  mobile_numbers: row.mobile_numbers,
  telephone_numbers: row.telephone_numbers,
  email_addresses: row.email_addresses,
  country: row.country,
  appointment_scope: row.appointment_scope,
  max_ship_length_meters: row.max_ship_length_meters,
  mlc_under_500gt_authorized: row.mlc_under_500gt_authorized,
  source_published_date: row.source_published_date,
  source_name: row.source_name,
  source_document_title: row.source_document_title,
});

export const getAppointedSurveyors = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const country = String(req.query.country || "").trim();
    const scope = String(req.query.scope || "").trim().toLowerCase();
    const mlc = String(req.query.mlc || "").trim().toLowerCase();

    if (scope && !ALLOWED_SCOPES.has(scope)) {
      return res.status(400).json({
        success: false,
        message: "Unsupported appointment scope",
      });
    }

    if (mlc && !ALLOWED_MLC_VALUES.has(mlc)) {
      return res.status(400).json({
        success: false,
        message: "Unsupported MLC authorization value",
      });
    }

    const values = [];
    const conditions = ["is_active = true"];

    if (search) {
      values.push(`%${search}%`);
      const placeholder = `$${values.length}`;
      conditions.push(`(
        full_name ILIKE ${placeholder}
        OR organization_name ILIKE ${placeholder}
        OR address_text ILIKE ${placeholder}
        OR mobile_numbers ILIKE ${placeholder}
        OR telephone_numbers ILIKE ${placeholder}
        OR email_addresses ILIKE ${placeholder}
        OR country ILIKE ${placeholder}
      )`);
    }

    if (country) {
      values.push(country);
      conditions.push(
        `LOWER(TRIM(country)) = LOWER(TRIM($${values.length}))`
      );
    }

    if (scope) {
      values.push(scope);
      conditions.push(`appointment_scope = $${values.length}`);
    }

    if (mlc) {
      values.push(mlc === "true");
      conditions.push(`mlc_under_500gt_authorized = $${values.length}`);
    }

    const [surveyorResult, countryResult] = await Promise.all([
      pool.query(
        `
        SELECT
          id,
          professional_title,
          full_name,
          organization_name,
          address_text,
          mobile_numbers,
          telephone_numbers,
          email_addresses,
          country,
          appointment_scope,
          max_ship_length_meters,
          mlc_under_500gt_authorized,
          source_published_date,
          source_name,
          source_document_title
        FROM public.appointed_ship_surveyors
        WHERE ${conditions.join("\n          AND ")}
        ORDER BY LOWER(country) ASC, LOWER(full_name) ASC, id ASC
        `,
        values
      ),
      pool.query(
        `
        SELECT country
        FROM public.appointed_ship_surveyors
        WHERE is_active = true
          AND NULLIF(TRIM(country), '') IS NOT NULL
        GROUP BY country
        ORDER BY LOWER(country) ASC, country ASC
        `
      ),
    ]);

    const surveyors = surveyorResult.rows.map(mapSurveyor);

    return res.json({
      success: true,
      summary: {
        surveyor_count: surveyors.length,
        country_count: new Set(
          surveyors.map((surveyor) => surveyor.country.toLowerCase())
        ).size,
        general_count: surveyors.filter(
          (surveyor) => surveyor.appointment_scope === "general"
        ).length,
        restricted_count: surveyors.filter(
          (surveyor) => surveyor.appointment_scope === "restricted"
        ).length,
        mlc_authorized_count: surveyors.filter(
          (surveyor) => surveyor.mlc_under_500gt_authorized
        ).length,
      },
      filters: {
        countries: countryResult.rows.map((row) => row.country),
      },
      surveyors,
    });
  } catch (error) {
    console.error("Failed to fetch appointed ship surveyors", {
      name: error?.name,
      code: error?.code,
    });
    return res.status(500).json({
      success: false,
      message: "Failed to fetch appointed ship surveyors",
    });
  }
};
