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

// Missing configuration uses one hour; explicit values must be 1 minute–24 hours.
// Bare integers are seconds (including environment strings), never JWT milliseconds.
export const parseRegistrationTokenLifetime = (value) => {
  if (value === undefined || value === null || value === "") return 3600;
  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(String(value).trim());
  const seconds = match ? Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[match[2]?.toLowerCase() || "s"]) : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86400) {
    throw Object.assign(new Error("Registration token lifetime must be between 60 and 86400 seconds, optionally using s, m, h or d"), { code: "REGISTRATION_TOKEN_TTL_INVALID" });
  }
  return seconds;
};

export const getRegistrationTokenLifetime = () => parseRegistrationTokenLifetime(process.env.CLIENT_REGISTRATION_TOKEN_TTL);

export const createRegistrationDraftToken = ({ email, draftId, expiresIn } = {}) =>
  jwt.sign(
    { email: normalizeEmail(email), draftId, purpose: "client-registration-draft" },
    registrationSecret(),
    { expiresIn: parseRegistrationTokenLifetime(expiresIn ?? process.env.CLIENT_REGISTRATION_TOKEN_TTL) }
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
