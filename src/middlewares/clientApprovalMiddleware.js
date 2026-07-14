import { pool } from "../config/db.js";

export const requireApprovedClient = async (req, res, next) => {
  if (Number(req.user?.role_id) !== 3) return next();

  try {
    const result = await pool.query(
      `
      SELECT u.is_active, cp.verification_status
      FROM users u
      LEFT JOIN client_profiles cp ON cp.user_id = u.id
      WHERE u.id = $1
      LIMIT 1
      `,
      [req.user.id]
    );
    const record = result.rows[0];
    if (record?.is_active && record.verification_status === "approved") return next();

    return res.status(403).json({
      success: false,
      code: "CLIENT_VERIFICATION_REQUIRED",
      verification_status: record?.verification_status || "missing",
      message: "Client verification is required before accessing this feature.",
    });
  } catch {
    return res.status(503).json({
      success: false,
      code: "CLIENT_VERIFICATION_UNAVAILABLE",
      message: "Client verification status is temporarily unavailable.",
    });
  }
};
