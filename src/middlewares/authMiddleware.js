import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";

const safeDatabaseErrorCode = (error) => {
  const code = String(error?.code || "UNKNOWN").toUpperCase();
  return /^[A-Z0-9_]{1,40}$/.test(code) ? code : "UNKNOWN";
};

export const createRequireAuth = ({
  verifyToken = (token) => jwt.verify(token, process.env.JWT_SECRET),
  queryUser = (userId) => pool.query(
    `SELECT id, full_name, email, username, role_id, is_active FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  ),
  logError = console.error,
} = {}) => async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Authorization token required",
    });
  }

  const token = authHeader.split(" ")[1];
  let decoded;
  try {
    decoded = verifyToken(token);
  } catch {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }

  let current;
  try {
    current = await queryUser(decoded.id);
  } catch (error) {
    logError("Authentication service database lookup failed", {
      category: "database_unavailable",
      code: safeDatabaseErrorCode(error),
    });
    return res.status(503).json({
      success: false,
      message: "Authentication service temporarily unavailable",
    });
  }

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
};

export const requireAuth = createRequireAuth();

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
