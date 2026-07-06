import { pool } from "../config/db.js";

export const createPort = async (req, res) => {
  try {
    const {
      port_name,
      country,
      region,
      description,
      psc_risk_level,
      experts_available,
      vessel_types = [],
      services = [],
    } = req.body;

    if (!port_name || !country || !region) {
      return res.status(400).json({
        message: "port_name, country and region are required",
      });
    }

    const portResult = await pool.query(
      `
      INSERT INTO ports (
        port_name, country, region, description, psc_risk_level, experts_available
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
      `,
      [
        port_name,
        country,
        region,
        description || null,
        psc_risk_level || "Medium",
        experts_available || 0,
      ]
    );

    const port = portResult.rows[0];

    for (const type of vessel_types) {
      await pool.query(
        `
        INSERT INTO port_vessel_types (port_id, vessel_type)
        VALUES ($1, $2)
        ON CONFLICT (port_id, vessel_type) DO NOTHING
        `,
        [port.id, type]
      );
    }

    for (const service of services) {
      await pool.query(
        `
        INSERT INTO port_services (port_id, service_name)
        VALUES ($1, $2)
        ON CONFLICT (port_id, service_name) DO NOTHING
        `,
        [port.id, service]
      );
    }

    res.status(201).json({
      message: "Port created successfully",
      port,
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        message: "Port already exists for this country",
      });
    }

    res.status(500).json({
      message: "Failed to create port",
      error: error.message,
    });
  }
};

export const getPorts = async (req, res) => {
  try {
    const { search, region } = req.query;

    const values = [];
    let query = `
      SELECT
        p.id,
        p.port_name,
        p.country,
        p.region,
        p.description,
        p.psc_risk_level,
        p.is_active,
        p.created_at,
        p.updated_at,
        COALESCE(epc.experts_available, 0)::int AS experts_available,
        COALESCE(
          ARRAY_AGG(DISTINCT pvt.vessel_type) FILTER (WHERE pvt.vessel_type IS NOT NULL),
          '{}'
        ) AS vessel_types,
        COALESCE(
          ARRAY_AGG(DISTINCT ps.service_name) FILTER (WHERE ps.service_name IS NOT NULL),
          '{}'
        ) AS services
      FROM ports p
      LEFT JOIN (
        SELECT
          LOWER(TRIM(port_name)) AS normalized_port_name,
          COUNT(DISTINCT expert_id) AS experts_available
        FROM expert_ports
        WHERE port_name IS NOT NULL AND TRIM(port_name) <> ''
        GROUP BY LOWER(TRIM(port_name))
      ) epc ON epc.normalized_port_name = LOWER(TRIM(p.port_name))
      LEFT JOIN port_vessel_types pvt ON pvt.port_id = p.id
      LEFT JOIN port_services ps ON ps.port_id = p.id
      WHERE p.is_active = true
    `;

    if (search) {
      values.push(`%${search}%`);
      query += `
        AND (
          p.port_name ILIKE $${values.length}
          OR p.country ILIKE $${values.length}
          OR p.region ILIKE $${values.length}
        )
      `;
    }

    if (region && region !== "All Regions") {
      values.push(region);
      query += ` AND p.region = $${values.length}`;
    }

    query += `
      GROUP BY p.id, epc.experts_available
      ORDER BY p.created_at DESC
    `;

    const result = await pool.query(query, values);

    res.json({
      message: "Ports fetched successfully",
      ports: result.rows,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch ports",
      error: error.message,
    });
  }
};

export const getPortById = async (req, res) => {
  try {
    const { id } = req.params;

    const portResult = await pool.query(
      `SELECT * FROM ports WHERE id = $1 AND is_active = true`,
      [id]
    );

    if (!portResult.rows.length) {
      return res.status(404).json({ message: "Port not found" });
    }

    const vesselTypes = await pool.query(
      `SELECT vessel_type FROM port_vessel_types WHERE port_id = $1`,
      [id]
    );

    const services = await pool.query(
      `SELECT service_name FROM port_services WHERE port_id = $1`,
      [id]
    );

    res.json({
      message: "Port fetched successfully",
      port: {
        ...portResult.rows[0],
        vessel_types: vesselTypes.rows.map((row) => row.vessel_type),
        services: services.rows.map((row) => row.service_name),
      },
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch port",
      error: error.message,
    });
  }
};

export const updatePort = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      port_name,
      country,
      region,
      description,
      psc_risk_level,
      experts_available,
      vessel_types,
      services,
    } = req.body;

    const result = await pool.query(
      `
      UPDATE ports
      SET
        port_name = COALESCE($1, port_name),
        country = COALESCE($2, country),
        region = COALESCE($3, region),
        description = COALESCE($4, description),
        psc_risk_level = COALESCE($5, psc_risk_level),
        experts_available = COALESCE($6, experts_available),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $7 AND is_active = true
      RETURNING *
      `,
      [
        port_name,
        country,
        region,
        description,
        psc_risk_level,
        experts_available,
        id,
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "Port not found" });
    }

    if (Array.isArray(vessel_types)) {
      await pool.query(`DELETE FROM port_vessel_types WHERE port_id = $1`, [id]);

      for (const type of vessel_types) {
        await pool.query(
          `
          INSERT INTO port_vessel_types (port_id, vessel_type)
          VALUES ($1, $2)
          ON CONFLICT (port_id, vessel_type) DO NOTHING
          `,
          [id, type]
        );
      }
    }

    if (Array.isArray(services)) {
      await pool.query(`DELETE FROM port_services WHERE port_id = $1`, [id]);

      for (const service of services) {
        await pool.query(
          `
          INSERT INTO port_services (port_id, service_name)
          VALUES ($1, $2)
          ON CONFLICT (port_id, service_name) DO NOTHING
          `,
          [id, service]
        );
      }
    }

    res.json({
      message: "Port updated successfully",
      port: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        message: "Port already exists for this country",
      });
    }

    res.status(500).json({
      message: "Failed to update port",
      error: error.message,
    });
  }
};

export const deletePort = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      UPDATE ports
      SET is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND is_active = true
      RETURNING *
      `,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "Port not found" });
    }

    res.json({ message: "Port deleted successfully" });
  } catch (error) {
    res.status(500).json({
      message: "Failed to delete port",
      error: error.message,
    });
  }
};
