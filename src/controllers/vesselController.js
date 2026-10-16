import { pool } from "../config/db.js";
import { listRequestVesselSuggestions, normalizeImo, validImo } from "../services/requestVesselService.js";

export const suggestRequestVessels = async (req, res) => {
  try { return res.json({ success: true, data: await listRequestVesselSuggestions(req.query.search, req.user) }); }
  catch { return res.status(503).json({ success: false, message: "Vessel suggestions are temporarily unavailable. You can enter details manually." }); }
};

const canAccessVessel = (user, vessel) => {
  const roleId = Number(user.role_id);

  if (roleId === 1) return true;
  if (roleId === 2) return true;
  if (roleId === 3) {
    return Number(vessel.created_by_user_id) === Number(user.id);
  }

  return false;
};

const fleetResponse = (vessel, user) => {
  if (Number(user.role_id) !== 3) return vessel;
  const { created_by_user_id, ...safe } = vessel;
  if (Number(created_by_user_id) !== Number(user.id)) {
    safe.trading_area = null;
    safe.owner_manager = null;
  }
  return safe;
};

export const createVessel = async (req, res) => {
  let db;
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
    const normalizedImo = normalizeImo(imo_number);
    if (!validImo(normalizedImo)) return res.status(400).json({ success: false, message: "Enter a valid seven-digit IMO number." });

    db = await pool.connect();
    await db.query("BEGIN");
    const result = await db.query(
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
        normalizedImo,
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

    if (Number(req.user.role_id) === 3) await db.query(`INSERT INTO client_vessel_associations(client_user_id,vessel_id)
      VALUES($1,$2) ON CONFLICT(client_user_id,vessel_id) DO NOTHING`, [req.user.id, result.rows[0].id]);
    await db.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Vessel registered successfully",
      data: result.rows[0],
    });
  } catch (error) {
    if (db) await db.query("ROLLBACK").catch(() => {});
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
  } finally { db?.release(); }
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
          flag_state ILIKE $${values.length} OR
          vessels.public_id ILIKE $${values.length} OR
          EXISTS (SELECT 1 FROM magicport_vessel_directory d WHERE d.master_vessel_id=vessels.id AND d.public_id ILIKE $${values.length})
        )
      `);
    }

    let clientParam = null;
    if (Number(req.user.role_id) === 3) {
      values.push(req.user.id);
      clientParam = values.length;
      conditions.push(`EXISTS (SELECT 1 FROM client_vessel_associations cva
        WHERE cva.vessel_id=vessels.id AND cva.client_user_id=$${values.length})`);
    }

    const result = await pool.query(
      `
      SELECT vessels.*, COALESCE((SELECT d.public_id FROM magicport_vessel_directory d WHERE d.master_vessel_id=vessels.id ORDER BY d.id LIMIT 1),vessels.public_id) AS public_id, ${clientParam ? `(created_by_user_id=$${clientParam} AND
        NOT EXISTS(SELECT 1 FROM magicport_vessel_directory WHERE master_vessel_id=vessels.id) AND
        (SELECT COUNT(*) FROM client_vessel_associations WHERE vessel_id=vessels.id)=1)` : "TRUE"} AS can_edit
      FROM vessels
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      `,
      values
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows.map((row) => fleetResponse(row, req.user)),
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
      `SELECT v.*,COALESCE((SELECT d.public_id FROM magicport_vessel_directory d WHERE d.master_vessel_id=v.id ORDER BY d.id LIMIT 1),v.public_id) AS public_id FROM vessels v WHERE v.id = $1 AND v.is_active = true`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Vessel not found",
      });
    }

    const associated = Number(req.user.role_id) === 3 && (await pool.query(
      "SELECT 1 FROM client_vessel_associations WHERE client_user_id=$1 AND vessel_id=$2", [req.user.id, id]
    )).rowCount > 0;
    if (!canAccessVessel(req.user, result.rows[0]) && !associated) {
      return res.status(403).json({
        success: false,
        message: "Access denied for this vessel",
      });
    }

    res.json({
      success: true,
      message: "Vessel fetched successfully",
      data: fleetResponse(result.rows[0], req.user),
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

    if (Number(req.user.role_id) === 3) {
      const protectedRecord = await pool.query(`SELECT
        EXISTS(SELECT 1 FROM magicport_vessel_directory WHERE master_vessel_id=$1) AS imported,
        (SELECT COUNT(*)::int FROM client_vessel_associations WHERE vessel_id=$1) AS associations`, [id]);
      if (protectedRecord.rows[0]?.imported || Number(protectedRecord.rows[0]?.associations) > 1) {
        return res.status(403).json({ success: false, message: "This shared or imported vessel record cannot be edited from My Vessels." });
      }
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

    const associated = Number(req.user.role_id) === 3 && (await pool.query(
      "SELECT 1 FROM client_vessel_associations WHERE client_user_id=$1 AND vessel_id=$2", [req.user.id, id]
    )).rowCount > 0;
    if (!canAccessVessel(req.user, existing.rows[0]) && !associated) {
      return res.status(403).json({
        success: false,
        message: "Only owner or admin can delete this vessel",
      });
    }

    if (Number(req.user.role_id) === 3) {
      await pool.query("DELETE FROM client_vessel_associations WHERE client_user_id=$1 AND vessel_id=$2", [req.user.id, id]);
      return res.json({ success: true, message: "Vessel removed from My Vessels" });
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
