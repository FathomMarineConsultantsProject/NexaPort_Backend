import pool from "../config/db.js";

export const createVessel = async (req, res) => {
  try {
    const {
      vessel_name,
      imo_number,
      vessel_type,
      flag_state,
      class_subtype,
      dwt,
      gt,
      year_built,
      trading_area,
      owner_manager,
    } = req.body;

    if (!vessel_name || !imo_number || !vessel_type || !flag_state) {
      return res.status(400).json({
        message: "vessel_name, imo_number, vessel_type and flag_state are required",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO vessels (
        vessel_name, imo_number, vessel_type, flag_state,
        class_subtype, dwt, gt, year_built, trading_area, owner_manager
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
      `,
      [
        vessel_name,
        imo_number,
        vessel_type,
        flag_state,
        class_subtype || null,
        dwt || null,
        gt || null,
        year_built || null,
        trading_area || null,
        owner_manager || null,
      ]
    );

    res.status(201).json({
      message: "Vessel registered successfully",
      vessel: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ message: "IMO number already exists" });
    }

    res.status(500).json({ message: "Failed to create vessel", error: error.message });
  }
};

export const getVessels = async (req, res) => {
  try {
    const { search } = req.query;

    let query = `
      SELECT *
      FROM vessels
      WHERE is_active = true
    `;

    const values = [];

    if (search) {
      values.push(`%${search}%`);
      query += `
        AND (
          vessel_name ILIKE $1 OR
          imo_number ILIKE $1 OR
          vessel_type ILIKE $1 OR
          flag_state ILIKE $1
        )
      `;
    }

    query += ` ORDER BY created_at DESC`;

    const result = await pool.query(query, values);

    res.json({
      message: "Vessels fetched successfully",
      vessels: result.rows,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch vessels", error: error.message });
  }
};

export const getVesselById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT * FROM vessels WHERE id = $1 AND is_active = true`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "Vessel not found" });
    }

    res.json({
      message: "Vessel fetched successfully",
      vessel: result.rows[0],
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch vessel", error: error.message });
  }
};

export const updateVessel = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      vessel_name,
      imo_number,
      vessel_type,
      flag_state,
      class_subtype,
      dwt,
      gt,
      year_built,
      trading_area,
      owner_manager,
    } = req.body;

    const result = await pool.query(
      `
      UPDATE vessels
      SET
        vessel_name = COALESCE($1, vessel_name),
        imo_number = COALESCE($2, imo_number),
        vessel_type = COALESCE($3, vessel_type),
        flag_state = COALESCE($4, flag_state),
        class_subtype = $5,
        dwt = $6,
        gt = $7,
        year_built = $8,
        trading_area = $9,
        owner_manager = $10,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $11 AND is_active = true
      RETURNING *
      `,
      [
        vessel_name,
        imo_number,
        vessel_type,
        flag_state,
        class_subtype || null,
        dwt || null,
        gt || null,
        year_built || null,
        trading_area || null,
        owner_manager || null,
        id,
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "Vessel not found" });
    }

    res.json({
      message: "Vessel updated successfully",
      vessel: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ message: "IMO number already exists" });
    }

    res.status(500).json({ message: "Failed to update vessel", error: error.message });
  }
};

export const deleteVessel = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      UPDATE vessels
      SET is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND is_active = true
      RETURNING *
      `,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "Vessel not found" });
    }

    res.json({ message: "Vessel deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete vessel", error: error.message });
  }
};