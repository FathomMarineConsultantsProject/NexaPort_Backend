import jwt from "jsonwebtoken";

export const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

const registrationSecret = () => {
  if (!process.env.CLIENT_REGISTRATION_TOKEN_SECRET) {
    const error = new Error("Client registration token service is not configured");
    error.code = "REGISTRATION_TOKEN_NOT_CONFIGURED";
    throw error;
  }
  return process.env.CLIENT_REGISTRATION_TOKEN_SECRET;
};

export const createRegistrationDraftToken = ({ email, draftId, expiresIn } = {}) =>
  jwt.sign(
    { email: normalizeEmail(email), draftId, purpose: "client-registration-draft" },
    registrationSecret(),
    { expiresIn: expiresIn || process.env.CLIENT_REGISTRATION_TOKEN_TTL || "60m" }
  );

export const verifyRegistrationDraftToken = (token) => {
  const decoded = jwt.verify(token, registrationSecret());
  if (decoded.purpose !== "client-registration-draft" || !decoded.email || !decoded.draftId) {
    throw new Error("Invalid registration draft token");
  }
  return decoded;
};

export const registrationDraftMatchesEmail = (identity, email) =>
  Boolean(identity?.draftId && identity.email === normalizeEmail(email));

export const getRegistrationBearer = (req) => {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return "";
};
