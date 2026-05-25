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

export const getServiceRequestDropdowns = async (req, res) => {
  try {
    const [
      serviceTypes,
      serviceCategories,
      urgencies,
      statuses,
      vesselTypes,
      flagStates,
    ] = await Promise.all([
      pool.query(`SELECT id, name FROM master_service_types ORDER BY name ASC`),

      pool.query(`
        SELECT 
          msc.id,
          msc.name,
          mst.name AS service_type
        FROM master_service_categories msc
        JOIN master_service_types mst ON mst.id = msc.service_type_id
        ORDER BY mst.name ASC, msc.name ASC
      `),

      pool.query(`SELECT id, label, value FROM master_urgencies ORDER BY id ASC`),

      pool.query(`SELECT id, name FROM master_request_statuses ORDER BY id ASC`),

      pool.query(`SELECT id, name FROM master_vessel_types ORDER BY name ASC`),

      pool.query(`SELECT id, name FROM master_flag_states ORDER BY name ASC`),
    ]);

    const categoriesByType = {};

    serviceCategories.rows.forEach((item) => {
      if (!categoriesByType[item.service_type]) {
        categoriesByType[item.service_type] = [];
      }

      categoriesByType[item.service_type].push({
        id: item.id,
        name: item.name,
      });
    });

    res.json({
      success: true,
      data: {
        serviceTypes: serviceTypes.rows,
        serviceCategories: categoriesByType,
        urgencyOptions: urgencies.rows,
        statuses: statuses.rows,
        vesselTypes: vesselTypes.rows,
        flagStates: flagStates.rows,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch service request dropdowns",
      error: error.message,
    });
  }
};