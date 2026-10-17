import { pool } from "../config/db.js";

export const normalizePortText = (value) => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
export const portIdentity = (value) => normalizePortText(value).toLocaleLowerCase("en");

export const findOrCreatePort = async ({
  port_name,
  country,
  region,
  description = null,
  queryable = pool,
}) => {
  const name = normalizePortText(port_name);
  const countryName = normalizePortText(country);
  if (!name || !countryName || name.length > 240 || countryName.length > 120) {
    throw Object.assign(new Error("Enter a valid port name and country."), { status: 400 });
  }
  // The caller runs in the request transaction. Serialize matching manual entries
  // until a database uniqueness constraint can cover the same normalized identity.
  await queryable.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || '|' || $2, 0))", [portIdentity(name), portIdentity(countryName)]);
  const existingPort = await queryable.query(
    `
    SELECT *
    FROM ports
    WHERE LOWER(regexp_replace(BTRIM(port_name), '[[:space:]]+', ' ', 'g')) = $1
      AND LOWER(regexp_replace(BTRIM(country), '[[:space:]]+', ' ', 'g')) = $2
      AND is_active = true
    LIMIT 1
    `,
    [portIdentity(name), portIdentity(countryName)]
  );

  if (existingPort.rows.length) {
    return existingPort.rows[0];
  }

  const newPort = await queryable.query(
    `
    INSERT INTO ports (
      port_name, country, region, description, psc_risk_level, experts_available
    )
    VALUES ($1,$2,$3,$4,'Medium',0)
    RETURNING *
    `,
    [name, countryName, region, description]
  );

  return newPort.rows[0];
};
