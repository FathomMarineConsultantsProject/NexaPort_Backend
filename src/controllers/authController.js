import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";
import { sendPasswordResetOtp } from "../services/emailService.js";
import {
  generateOtp,
  hashOtp,
  verifyOtpHash,
} from "../services/passwordResetService.js";

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

const validateNewPassword = (password) => {
  return (
    typeof password === "string" &&
    password.length >= 8 &&
    /[A-Za-z]/.test(password) &&
    /\d/.test(password)
  );
};

const normalizeEmail = (email) => {
  return String(email || "")
    .trim()
    .toLowerCase();
};

/**
 * Step 1:
 * User submits email and receives OTP.
 *
 * POST /api/auth/forgot-password/send-otp
 *
 * Body:
 * {
 *   "email": "user@example.com"
 * }
 */
export const sendForgotPasswordOtp = async (req, res) => {
  const client = await pool.connect();

  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address",
      });
    }

    const userResult = await client.query(
      `
      SELECT
        id,
        full_name,
        email,
        is_active
      FROM users
      WHERE LOWER(email) = $1
      LIMIT 1
      `,
      [email]
    );

    /*
     * Generic response prevents outsiders from checking
     * which email addresses are registered.
     */
    if (!userResult.rows.length) {
      return res.json({
        success: true,
        message:
          "If this email is registered, an OTP has been sent.",
      });
    }

    const user = userResult.rows[0];

    if (!user.is_active) {
      return res.json({
        success: true,
        message:
          "If this email is registered, an OTP has been sent.",
      });
    }

    const expiryMinutes = Number(
      process.env.PASSWORD_RESET_OTP_EXPIRY_MINUTES || 10
    );

    const otp = generateOtp();
    const otpHash = hashOtp(otp);

    await client.query("BEGIN");

    /*
     * Disable all previous unused OTPs for this user.
     */
    await client.query(
      `
      UPDATE password_reset_otps
      SET used_at = CURRENT_TIMESTAMP
      WHERE user_id = $1
        AND used_at IS NULL
      `,
      [user.id]
    );

    await client.query(
      `
      INSERT INTO password_reset_otps (
        user_id,
        email,
        otp_hash,
        attempts,
        expires_at
      )
      VALUES (
        $1,
        $2,
        $3,
        0,
        CURRENT_TIMESTAMP + ($4 * INTERVAL '1 minute')
      )
      `,
      [
        user.id,
        email,
        otpHash,
        expiryMinutes,
      ]
    );

    await sendPasswordResetOtp({
      email,
      fullName: user.full_name,
      otp,
    });

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "OTP sent successfully",
      data: {
        email,
        expires_in_minutes: expiryMinutes,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Send forgot password OTP error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to send OTP",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  } finally {
    client.release();
  }
};

/**
 * Step 2:
 * User submits email, OTP and new password.
 *
 * POST /api/auth/forgot-password/reset
 *
 * Body:
 * {
 *   "email": "user@example.com",
 *   "otp": "123456",
 *   "new_password": "Password123",
 *   "confirm_password": "Password123"
 * }
 */
export const resetForgottenPassword = async (req, res) => {
  const client = await pool.connect();

  try {
    const email = normalizeEmail(req.body.email);

    const otp = String(req.body.otp || "").trim();

    const newPassword = req.body.new_password;
    const confirmPassword = req.body.confirm_password;

    if (
      !email ||
      !otp ||
      !newPassword ||
      !confirmPassword
    ) {
      return res.status(400).json({
        success: false,
        message:
          "email, otp, new_password and confirm_password are required",
      });
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        success: false,
        message: "OTP must contain exactly 6 digits",
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Passwords do not match",
      });
    }

    if (!validateNewPassword(newPassword)) {
      return res.status(400).json({
        success: false,
        message:
          "Password must be at least 8 characters and include letters and numbers",
      });
    }

    const maxAttempts = Number(
      process.env.PASSWORD_RESET_MAX_ATTEMPTS || 5
    );

    await client.query("BEGIN");

    const otpResult = await client.query(
      `
      SELECT
        pro.id,
        pro.user_id,
        pro.email,
        pro.otp_hash,
        pro.attempts,
        pro.expires_at,
        pro.used_at,
        u.password_hash,
        u.is_active
      FROM password_reset_otps pro
      INNER JOIN users u
        ON u.id = pro.user_id
      WHERE LOWER(pro.email) = $1
        AND pro.used_at IS NULL
      ORDER BY pro.created_at DESC
      LIMIT 1
      FOR UPDATE
      `,
      [email]
    );

    if (!otpResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message:
          "Invalid or expired OTP. Request a new OTP.",
      });
    }

    const record = otpResult.rows[0];

    if (!record.is_active) {
      await client.query("ROLLBACK");

      return res.status(403).json({
        success: false,
        message: "Account is inactive",
      });
    }

    if (Number(record.attempts) >= maxAttempts) {
      await client.query(
        `
        UPDATE password_reset_otps
        SET used_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [record.id]
      );

      await client.query("COMMIT");

      return res.status(429).json({
        success: false,
        message:
          "Maximum OTP attempts exceeded. Request a new OTP.",
      });
    }

    if (
      new Date(record.expires_at).getTime() <
      Date.now()
    ) {
      await client.query(
        `
        UPDATE password_reset_otps
        SET used_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [record.id]
      );

      await client.query("COMMIT");

      return res.status(400).json({
        success: false,
        message:
          "OTP has expired. Request a new OTP.",
      });
    }

    const otpMatches = verifyOtpHash(
      otp,
      record.otp_hash
    );

    if (!otpMatches) {
      await client.query(
        `
        UPDATE password_reset_otps
        SET attempts = attempts + 1
        WHERE id = $1
        `,
        [record.id]
      );

      await client.query("COMMIT");

      return res.status(400).json({
        success: false,
        message: "Invalid OTP",
      });
    }

    const samePassword = await bcrypt.compare(
      newPassword,
      record.password_hash
    );

    if (samePassword) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message:
          "New password must be different from the current password",
      });
    }

    const newPasswordHash = await bcrypt.hash(
      newPassword,
      12
    );

    await client.query(
      `
      UPDATE users
      SET
        password_hash = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      `,
      [
        newPasswordHash,
        record.user_id,
      ]
    );

    await client.query(
      `
      UPDATE password_reset_otps
      SET used_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [record.id]
    );

    /*
     * Disable any other active OTP belonging to the user.
     */
    await client.query(
      `
      UPDATE password_reset_otps
      SET used_at = CURRENT_TIMESTAMP
      WHERE user_id = $1
        AND used_at IS NULL
      `,
      [record.user_id]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message:
        "Password changed successfully. You can now login using your new password.",
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Reset forgotten password error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to change password",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  } finally {
    client.release();
  }
};
