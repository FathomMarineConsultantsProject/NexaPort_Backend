import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";

export const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authorization token required",
      });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const current = await pool.query(
      `SELECT id, full_name, email, username, role_id, is_active FROM users WHERE id = $1 LIMIT 1`,
      [decoded.id]
    );
    const user = current.rows[0];
    if (!user || !user.is_active) {
      return res.status(401).json({
        success: false,
        code: "ACCOUNT_INACTIVE",
        message: "This account is inactive or no longer exists",
      });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
};

export const allowRoles = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(Number(req.user.role_id))) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    next();
  };
};
