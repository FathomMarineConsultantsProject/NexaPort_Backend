import { pool } from "../config/db.js";

export const getSpecialties = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name
      FROM master_specialties
      ORDER BY name ASC
    `);

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch specialties",
      error: error.message,
    });
  }
};

export const getVesselTypes = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name
      FROM master_vessel_types
      ORDER BY name ASC
    `);

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch vessel types",
      error: error.message,
    });
  }
};

export const getCertifications = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name
      FROM master_certifications
      ORDER BY name ASC
    `);

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch certifications",
      error: error.message,
    });
  }
};