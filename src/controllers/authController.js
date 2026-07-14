import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";

export const createToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      username: user.username,
      role_id: user.role_id,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
};

export const register = async (req, res) => {
  const client = await pool.connect();

  try {
    const { full_name, email, username, password, phone } = req.body;

    if (!full_name || !email || !username || !password) {
      return res.status(400).json({
        success: false,
        message: "full_name, email, username and password are required",
      });
    }

    if (typeof password !== "string" || password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters and include letters and numbers",
      });
    }

    if (!/^\S+@\S+\.\S+$/.test(String(email).trim())) {
      return res.status(400).json({ success: false, message: "A valid email is required" });
    }

    const existing = await pool.query(
      `SELECT id FROM users WHERE email = $1 OR username = $2`,
      [email.toLowerCase(), username]
    );

    if (existing.rows.length) {
      return res.status(409).json({
        success: false,
        message: "Email or username already exists",
      });
    }

    await client.query("BEGIN");

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await client.query(
      `
      INSERT INTO users (
        full_name,
        email,
        username,
        password_hash,
        role_id,
        phone,
        is_active
      )
      VALUES ($1,$2,$3,$4,$5,$6,true)
      RETURNING id, full_name, email, username, role_id, phone, is_active, created_at
      `,
      [
        full_name,
        email.toLowerCase(),
        username,
        passwordHash,
        3,
        phone || null,
      ]
    );

    const user = result.rows[0];

    const profileResult = await client.query(
      `
      INSERT INTO client_profiles (
        user_id,
        verification_status,
        verification_submitted_at
      )
      VALUES ($1, 'pending', CURRENT_TIMESTAMP)
      RETURNING id, verification_status
      `,
      [user.id]
    );
    await client.query(
      `INSERT INTO client_verification_events (client_profile_id, previous_status, new_status) VALUES ($1, NULL, 'pending')`,
      [profileResult.rows[0].id]
    );

    await client.query("COMMIT");

    const responseUser = {
      ...user,
      verification_status: profileResult.rows[0].verification_status,
    };
    const token = createToken(responseUser);

    res.status(201).json({
      success: true,
      message: "Legacy Client account created. Complete Client onboarding before operational access.",
      token,
      user: responseUser,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    res.status(500).json({
      success: false,
      message: "Registration failed",
      error: error.message,
    });
  } finally {
    client.release();
  }
};

export const login = async (req, res) => {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({
        success: false,
        message: "identifier and password are required",
      });
    }

    const result = await pool.query(
      `
      SELECT u.id, u.full_name, u.email, u.username, u.password_hash, u.role_id,
             u.phone, u.is_active, cp.verification_status
      FROM users u
      LEFT JOIN client_profiles cp ON cp.user_id = u.id
      WHERE u.email = $1 OR u.username = $1
      `,
      [identifier.toLowerCase()]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        success: false,
        message: "Invalid login credentials",
      });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: "Account is inactive",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid login credentials",
      });
    }

    delete user.password_hash;
    if (Number(user.role_id) === 3 && !user.verification_status) {
      user.verification_status = "missing";
    }

    const token = createToken(user);

    res.json({
      success: true,
      message: "Login successful",
      token,
      user,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Login failed",
      error: error.message,
    });
  }
};

export const getMe = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT u.id, u.full_name, u.email, u.username, u.role_id, u.phone,
             u.is_active, u.created_at, cp.verification_status
      FROM users u
      LEFT JOIN client_profiles cp ON cp.user_id = u.id
      WHERE u.id = $1
      `,
      [req.user.id]
    );

    res.json({
      success: true,
      data: result.rows[0]
        ? {
            ...result.rows[0],
            verification_status:
              Number(result.rows[0].role_id) === 3
                ? result.rows[0].verification_status || "missing"
                : null,
          }
        : null,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch profile",
    });
  }
};
