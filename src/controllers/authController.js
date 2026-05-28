import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";

const createToken = (user) => {
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
  try {
    const { full_name, email, username, password, role_id, phone } = req.body;

    if (!full_name || !email || !username || !password) {
      return res.status(400).json({
        success: false,
        message: "full_name, email, username and password are required",
      });
    }
    const requestedRoleId = Number(role_id) || 3;

    if (![1, 2, 3].includes(requestedRoleId)) {
      return res.status(400).json({
        success: false,
        message: "role_id must be 1, 2 or 3",
      });
    }

    if (requestedRoleId === 1 && req.body.admin_secret !== process.env.ADMIN_REGISTRATION_SECRET) {
      return res.status(403).json({
        success: false,
        message: "Invalid admin registration secret",
      });
    }

    const existing = await pool.query(
      `SELECT id FROM users WHERE email = $1 OR username = $2`,
      [email, username]
    );

    if (existing.rows.length) {
      return res.status(409).json({
        success: false,
        message: "Email or username already exists",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `
      INSERT INTO users (
        full_name,
        email,
        username,
        password_hash,
        role_id,
        phone
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id, full_name, email, username, role_id, phone, is_active, created_at
      `,
      [
        full_name,
        email.toLowerCase(),
        username,
        passwordHash,
        requestedRoleId,
        phone || null,
      ]
    );

    const user = result.rows[0];
    const token = createToken(user);

    res.status(201).json({
      success: true,
      message: "Registered successfully",
      token,
      user,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Registration failed",
      error: error.message,
    });
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
      SELECT id, full_name, email, username, password_hash, role_id, phone, is_active
      FROM users
      WHERE email = $1 OR username = $1
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
      SELECT id, full_name, email, username, role_id, phone, is_active, created_at
      FROM users
      WHERE id = $1
      `,
      [req.user.id]
    );

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch profile",
    });
  }
};