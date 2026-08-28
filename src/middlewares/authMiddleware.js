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

// Public registration routes may also be used by a signed-in Client.  An absent
// or non-account bearer token is ignored because the registration draft token is
// validated separately by the controller.  A valid account token is resolved
// against the database so an existing account can be reused safely.
export const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ") || !process.env.JWT_SECRET) return next();
  let decoded;
  try {
    decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
  } catch {
    return next();
  }
  if (!decoded?.id) return next();
  try {
    const current = await pool.query(
      `SELECT id, full_name, email, username, role_id, is_active FROM users WHERE id = $1 LIMIT 1`,
      [decoded.id]
    );
    if (!current.rows[0]?.is_active) return res.status(401).json({ success: false, code: "ACCOUNT_INACTIVE", message: "This account is inactive or no longer exists" });
    req.user = current.rows[0];
    return next();
  } catch (error) {
    console.error("Optional authentication database lookup failed", { category: "database_unavailable", code: safeDatabaseErrorCode(error) });
    return res.status(503).json({ success: false, message: "Authentication service temporarily unavailable" });
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
