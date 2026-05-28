import { pool } from "../config/db.js";

const canAccessVessel = (user, vessel) => {
  const roleId = Number(user.role_id);

  if (roleId === 1) return true;
  if (roleId === 2) return true;
  if (roleId === 3) {
    return Number(vessel.created_by_user_id) === Number(user.id);
  }

  return false;
};

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
        success: false,
        message: "vessel_name, imo_number, vessel_type and flag_state are required",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO vessels (
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
        created_by_user_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
        req.user.id,
      ]
    );

    res.status(201).json({
      success: true,
      message: "Vessel registered successfully",
      data: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "IMO number already exists",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to create vessel",
      error: error.message,
    });
  }
};

export const getVessels = async (req, res) => {
  try {
    const { search } = req.query;

    const conditions = [`is_active = true`];
    const values = [];

    if (search) {
      values.push(`%${search}%`);
      conditions.push(`
        (
          vessel_name ILIKE $${values.length} OR
          imo_number ILIKE $${values.length} OR
          vessel_type ILIKE $${values.length} OR
          flag_state ILIKE $${values.length}
        )
      `);
    }

    if (Number(req.user.role_id) === 3) {
      values.push(req.user.id);
      conditions.push(`created_by_user_id = $${values.length}`);
    }

    const result = await pool.query(
      `
      SELECT *
      FROM vessels
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      `,
      values
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch vessels",
      error: error.message,
    });
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
      return res.status(404).json({
        success: false,
        message: "Vessel not found",
      });
    }

    if (!canAccessVessel(req.user, result.rows[0])) {
      return res.status(403).json({
        success: false,
        message: "Access denied for this vessel",
      });
    }

    res.json({
      success: true,
      message: "Vessel fetched successfully",
      data: result.rows[0],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch vessel",
      error: error.message,
    });
  }
};

export const updateVessel = async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query(
      `SELECT * FROM vessels WHERE id = $1 AND is_active = true`,
      [id]
    );

    if (!existing.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Vessel not found",
      });
    }

    if (!canAccessVessel(req.user, existing.rows[0])) {
      return res.status(403).json({
        success: false,
        message: "Only owner or admin can update this vessel",
      });
    }

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
        class_subtype = COALESCE($5, class_subtype),
        dwt = COALESCE($6, dwt),
        gt = COALESCE($7, gt),
        year_built = COALESCE($8, year_built),
        trading_area = COALESCE($9, trading_area),
        owner_manager = COALESCE($10, owner_manager),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $11 AND is_active = true
      RETURNING *
      `,
      [
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
        id,
      ]
    );

    res.json({
      success: true,
      message: "Vessel updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "IMO number already exists",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to update vessel",
      error: error.message,
    });
  }
};

export const deleteVessel = async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query(
      `SELECT * FROM vessels WHERE id = $1 AND is_active = true`,
      [id]
    );

    if (!existing.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Vessel not found",
      });
    }

    if (!canAccessVessel(req.user, existing.rows[0])) {
      return res.status(403).json({
        success: false,
        message: "Only owner or admin can delete this vessel",
      });
    }

    await pool.query(
      `
      UPDATE vessels
      SET is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND is_active = true
      `,
      [id]
    );

    res.json({
      success: true,
      message: "Vessel deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete vessel",
      error: error.message,
    });
  }
};