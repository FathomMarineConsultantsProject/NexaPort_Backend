import crypto from "crypto";
import jwt from "jsonwebtoken";

export const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

export const createOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

export const digestOtp = ({ email, draftId, otp }) => {
  if (!process.env.OTP_PEPPER) {
    const error = new Error("OTP service is not configured");
    error.code = "OTP_NOT_CONFIGURED";
    throw error;
  }
  return crypto
    .createHmac("sha256", process.env.OTP_PEPPER)
    .update(`${normalizeEmail(email)}:${draftId}:${otp}`)
    .digest("hex");
};

export const otpMatches = ({ expectedDigest, candidateDigest }) => {
  const expected = Buffer.from(String(expectedDigest || ""), "hex");
  const candidate = Buffer.from(String(candidateDigest || ""), "hex");
  return expected.length > 0 && expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
};

const registrationSecret = () => {
  if (!process.env.CLIENT_REGISTRATION_TOKEN_SECRET) {
    const error = new Error("Client registration token service is not configured");
    error.code = "REGISTRATION_TOKEN_NOT_CONFIGURED";
    throw error;
  }
  return process.env.CLIENT_REGISTRATION_TOKEN_SECRET;
};

export const createRegistrationToken = ({ email, draftId, challengeId }) =>
  jwt.sign(
    { email: normalizeEmail(email), draftId, challengeId, purpose: "verified-client-email" },
    registrationSecret(),
    { expiresIn: process.env.CLIENT_REGISTRATION_TOKEN_TTL || "60m" }
  );

export const verifyRegistrationToken = (token) => {
  const decoded = jwt.verify(token, registrationSecret());
  if (decoded.purpose !== "verified-client-email" || !decoded.email || !decoded.draftId || !decoded.challengeId) {
    throw new Error("Invalid registration token");
  }
  return decoded;
};

export const getRegistrationBearer = (req) => {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return String(req.body?.registrationToken || "").trim();
};
