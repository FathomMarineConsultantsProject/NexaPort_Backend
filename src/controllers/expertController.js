import { pool } from "../config/db.js";

export const getAllExperts = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM experts
      ORDER BY created_at DESC
    `);

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows,
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
    const { id } = req.params;

    const expertResult = await pool.query(
      `SELECT * FROM experts WHERE id = $1`,
      [id]
    );

    if (expertResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Expert not found",
      });
    }

    const specialties = await pool.query(
      `
      SELECT ms.id, ms.name
      FROM expert_specialties es
      JOIN master_specialties ms ON ms.id = es.specialty_id
      WHERE es.expert_id = $1
      `,
      [id]
    );

    const certifications = await pool.query(
      `
      SELECT mc.id, mc.name
      FROM expert_certifications ec
      JOIN master_certifications mc ON mc.id = ec.certification_id
      WHERE ec.expert_id = $1
      `,
      [id]
    );

    const vesselTypes = await pool.query(
      `
      SELECT mvt.id, mvt.name
      FROM expert_vessel_types evt
      JOIN master_vessel_types mvt ON mvt.id = evt.vessel_type_id
      WHERE evt.expert_id = $1
      `,
      [id]
    );

    const languages = await pool.query(
      `SELECT id, language_name FROM expert_languages WHERE expert_id = $1`,
      [id]
    );

    const ports = await pool.query(
      `SELECT id, port_name FROM expert_ports WHERE expert_id = $1`,
      [id]
    );

    res.json({
      success: true,
      data: {
        ...expertResult.rows[0],
        specialties: specialties.rows,
        certifications: certifications.rows,
        vessel_types: vesselTypes.rows,
        languages: languages.rows,
        ports: ports.rows,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch expert",
      error: error.message,
    });
  }
};

export const createExpert = async (req, res) => {
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
    } = req.body;

    if (!full_name) {
      return res.status(400).json({
        success: false,
        message: "full_name is required",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO experts (
        full_name,
        biography,
        base_location,
        country,
        day_rate_usd,
        years_experience,
        availability,
        is_premium
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
      `,
      [
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

    res.status(201).json({
      success: true,
      message: "Expert created successfully",
      data: result.rows[0],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to create expert",
      error: error.message,
    });
  }
};

export const updateExpert = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      full_name,
      biography,
      base_location,
      country,
      day_rate_usd,
      years_experience,
      availability,
      is_premium,
    } = req.body;

    const result = await pool.query(
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

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Expert not found",
      });
    }

    res.json({
      success: true,
      message: "Expert updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update expert",
      error: error.message,
    });
  }
};

export const deleteExpert = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `DELETE FROM experts WHERE id = $1 RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
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