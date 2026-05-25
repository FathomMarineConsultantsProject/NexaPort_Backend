import { pool } from "../config/db.js";

export const findOrCreatePort = async ({
  port_name,
  country,
  region,
  description = null,
}) => {
  const existingPort = await pool.query(
    `
    SELECT *
    FROM ports
    WHERE LOWER(port_name) = LOWER($1)
      AND LOWER(country) = LOWER($2)
      AND is_active = true
    LIMIT 1
    `,
    [port_name, country]
  );

  if (existingPort.rows.length) {
    return existingPort.rows[0];
  }

  const newPort = await pool.query(
    `
    INSERT INTO ports (
      port_name, country, region, description, psc_risk_level, experts_available
    )
    VALUES ($1,$2,$3,$4,'Medium',0)
    RETURNING *
    `,
    [port_name, country, region, description]
  );

  return newPort.rows[0];
};