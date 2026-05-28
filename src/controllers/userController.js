import { pool } from "../config/db.js";

const roleName = (roleId) => {
  if (Number(roleId) === 1) return "Super Admin";
  if (Number(roleId) === 2) return "Expert";
  if (Number(roleId) === 3) return "Client";
  return "User";
};

export const getMyProfile = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT 
        id,
        full_name,
        email,
        username,
        role_id,
        phone,
        profile_image,
        is_active,
        created_at,
        updated_at
      FROM users
      WHERE id = $1
      `,
      [req.user.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const user = result.rows[0];

    res.json({
      success: true,
      data: {
        ...user,
        role_name: roleName(user.role_id),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch profile",
      error: error.message,
    });
  }
};

export const updateMyProfile = async (req, res) => {
  try {
    const { full_name, username, phone, profile_image } = req.body;

    const result = await pool.query(
      `
      UPDATE users
      SET
        full_name = COALESCE($1, full_name),
        username = COALESCE($2, username),
        phone = COALESCE($3, phone),
        profile_image = COALESCE($4, profile_image),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING 
        id,
        full_name,
        email,
        username,
        role_id,
        phone,
        profile_image,
        is_active,
        created_at,
        updated_at
      `,
      [full_name, username, phone, profile_image, req.user.id]
    );

    const user = result.rows[0];

    res.json({
      success: true,
      message: "Profile updated successfully",
      data: {
        ...user,
        role_name: roleName(user.role_id),
      },
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Username already exists",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to update profile",
      error: error.message,
    });
  }
};