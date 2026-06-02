import { pool } from "../config/db.js";

const getExpertFullData = async (expertId) => {
  const expertResult = await pool.query(`SELECT * FROM experts WHERE id = $1`, [
    expertId,
  ]);

  if (!expertResult.rows.length) return null;

  const [specialties, certifications, vesselTypes, languages, ports] =
    await Promise.all([
      pool.query(
        `
        SELECT ms.id, ms.name
        FROM expert_specialties es
        JOIN master_specialties ms ON ms.id = es.specialty_id
        WHERE es.expert_id = $1
        `,
        [expertId]
      ),
      pool.query(
        `
        SELECT mc.id, mc.name
        FROM expert_certifications ec
        JOIN master_certifications mc ON mc.id = ec.certification_id
        WHERE ec.expert_id = $1
        `,
        [expertId]
      ),
      pool.query(
        `
        SELECT mvt.id, mvt.name
        FROM expert_vessel_types evt
        JOIN master_vessel_types mvt ON mvt.id = evt.vessel_type_id
        WHERE evt.expert_id = $1
        `,
        [expertId]
      ),
      pool.query(
        `SELECT id, language_name FROM expert_languages WHERE expert_id = $1`,
        [expertId]
      ),
      pool.query(`SELECT id, port_name FROM expert_ports WHERE expert_id = $1`, [
        expertId,
      ]),
    ]);

  return {
    ...expertResult.rows[0],
    specialties: specialties.rows,
    certifications: certifications.rows,
    vessel_types: vesselTypes.rows,
    languages: languages.rows,
    ports: ports.rows,
  };
};

const canAccessExpert = (user, expert) => {
  const roleId = Number(user.role_id);

  if (roleId === 1) return true;
  if (roleId === 2) return Number(expert.user_id) === Number(user.id);

  return false;
};

export const getAllExperts = async (req, res) => {
  try {
    const values = [];
    let whereSql = "";

    if (Number(req.user.role_id) === 2) {
      values.push(req.user.id);
      whereSql = `WHERE e.user_id = $1`;
    }

    const result = await pool.query(
      `
      SELECT 
        e.*,
        COALESCE(
          JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', ms.id, 'name', ms.name))
          FILTER (WHERE ms.id IS NOT NULL), '[]'
        ) AS specialties,
        COALESCE(
          JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', mvt.id, 'name', mvt.name))
          FILTER (WHERE mvt.id IS NOT NULL), '[]'
        ) AS vessel_types,
        COALESCE(
          JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', mc.id, 'name', mc.name))
          FILTER (WHERE mc.id IS NOT NULL), '[]'
        ) AS certifications
      FROM experts e
      LEFT JOIN expert_specialties es ON es.expert_id = e.id
      LEFT JOIN master_specialties ms ON ms.id = es.specialty_id
      LEFT JOIN expert_vessel_types evt ON evt.expert_id = e.id
      LEFT JOIN master_vessel_types mvt ON mvt.id = evt.vessel_type_id
      LEFT JOIN expert_certifications ec ON ec.expert_id = e.id
      LEFT JOIN master_certifications mc ON mc.id = ec.certification_id
      ${whereSql}
      GROUP BY e.id
      ORDER BY e.created_at DESC
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
      message: "Failed to fetch experts",
      error: error.message,
    });
  }
};

export const getExpertById = async (req, res) => {
  try {
    const expert = await getExpertFullData(req.params.id);

    if (!expert) {
      return res.status(404).json({
        success: false,
        message: "Expert not found",
      });
    }

    if (!canAccessExpert(req.user, expert)) {
      return res.status(403).json({
        success: false,
        message: "Access denied for this expert profile",
      });
    }

    res.json({
      success: true,
      data: expert,
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
  const client = await pool.connect();

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
      specialty_ids = [],
      certification_ids = [],
      vessel_type_ids = [],
      ports = [],
      languages = [],
      user_id,
    } = req.body;

    if (!full_name) {
      return res.status(400).json({
        success: false,
        message: "full_name is required",
      });
    }

    const expertUserId =
      Number(req.user.role_id) === 1 ? user_id || null : req.user.id;

    if (Number(req.user.role_id) === 2) {
      const existing = await pool.query(
        `SELECT id FROM experts WHERE user_id = $1`,
        [req.user.id]
      );

      if (existing.rows.length) {
        return res.status(409).json({
          success: false,
          message: "Expert profile already exists for this user",
        });
      }
    }

    await client.query("BEGIN");

    const expertResult = await client.query(
      `
      INSERT INTO experts (
        user_id,
        full_name,
        biography,
        base_location,
        country,
        day_rate_usd,
        years_experience,
        availability,
        is_premium
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
      `,
      [
        expertUserId,
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

    const expert = expertResult.rows[0];

    for (const specialtyId of specialty_ids) {
      await client.query(
        `INSERT INTO expert_specialties (expert_id, specialty_id) VALUES ($1, $2)`,
        [expert.id, specialtyId]
      );
    }

    for (const certificationId of certification_ids) {
      await client.query(
        `INSERT INTO expert_certifications (expert_id, certification_id) VALUES ($1, $2)`,
        [expert.id, certificationId]
      );
    }

    for (const vesselTypeId of vessel_type_ids) {
      await client.query(
        `INSERT INTO expert_vessel_types (expert_id, vessel_type_id) VALUES ($1, $2)`,
        [expert.id, vesselTypeId]
      );
    }

    for (const portName of ports) {
      await client.query(
        `INSERT INTO expert_ports (expert_id, port_name) VALUES ($1, $2)`,
        [expert.id, portName]
      );
    }

    for (const languageName of languages) {
      await client.query(
        `INSERT INTO expert_languages (expert_id, language_name) VALUES ($1, $2)`,
        [expert.id, languageName]
      );
    }

    await client.query("COMMIT");

    const fullExpert = await getExpertFullData(expert.id);

    res.status(201).json({
      success: true,
      message: "Expert created successfully",
      data: fullExpert,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    res.status(500).json({
      success: false,
      message: "Failed to create expert",
      error: error.message,
    });
  } finally {
    client.release();
  }
};

export const updateExpert = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    const existing = await client.query(`SELECT * FROM experts WHERE id = $1`, [
      id,
    ]);

    if (!existing.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Expert not found",
      });
    }

    if (!canAccessExpert(req.user, existing.rows[0])) {
      return res.status(403).json({
        success: false,
        message: "Only admin or profile owner can update this expert",
      });
    }

    const {
      full_name,
      biography,
      base_location,
      country,
      day_rate_usd,
      years_experience,
      availability,
      is_premium,
      specialty_ids,
      certification_ids,
      vessel_type_ids,
      ports,
      languages,
    } = req.body;

    await client.query("BEGIN");

    const result = await client.query(
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

    if (Array.isArray(specialty_ids)) {
      await client.query(`DELETE FROM expert_specialties WHERE expert_id = $1`, [
        id,
      ]);

      for (const specialtyId of specialty_ids) {
        await client.query(
          `INSERT INTO expert_specialties (expert_id, specialty_id) VALUES ($1, $2)`,
          [id, specialtyId]
        );
      }
    }

    if (Array.isArray(certification_ids)) {
      await client.query(
        `DELETE FROM expert_certifications WHERE expert_id = $1`,
        [id]
      );

      for (const certificationId of certification_ids) {
        await client.query(
          `INSERT INTO expert_certifications (expert_id, certification_id) VALUES ($1, $2)`,
          [id, certificationId]
        );
      }
    }

    if (Array.isArray(vessel_type_ids)) {
      await client.query(
        `DELETE FROM expert_vessel_types WHERE expert_id = $1`,
        [id]
      );

      for (const vesselTypeId of vessel_type_ids) {
        await client.query(
          `INSERT INTO expert_vessel_types (expert_id, vessel_type_id) VALUES ($1, $2)`,
          [id, vesselTypeId]
        );
      }
    }

    if (Array.isArray(ports)) {
      await client.query(`DELETE FROM expert_ports WHERE expert_id = $1`, [id]);

      for (const portName of ports) {
        await client.query(
          `INSERT INTO expert_ports (expert_id, port_name) VALUES ($1, $2)`,
          [id, portName]
        );
      }
    }

    if (Array.isArray(languages)) {
      await client.query(`DELETE FROM expert_languages WHERE expert_id = $1`, [
        id,
      ]);

      for (const languageName of languages) {
        await client.query(
          `INSERT INTO expert_languages (expert_id, language_name) VALUES ($1, $2)`,
          [id, languageName]
        );
      }
    }

    await client.query("COMMIT");

    const fullExpert = await getExpertFullData(result.rows[0].id);

    res.json({
      success: true,
      message: "Expert updated successfully",
      data: fullExpert,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    res.status(500).json({
      success: false,
      message: "Failed to update expert",
      error: error.message,
    });
  } finally {
    client.release();
  }
};

export const deleteExpert = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `DELETE FROM experts WHERE id = $1 RETURNING *`,
      [id]
    );

    if (!result.rows.length) {
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