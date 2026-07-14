import bcrypt from "bcrypt";
import crypto from "crypto";
import { pool } from "../config/db.js";
import { createToken } from "./authController.js";
import { sendClientRegistrationOtp } from "../services/emailService.js";
import {
  createOtp,
  createRegistrationToken,
  digestOtp,
  getRegistrationBearer,
  normalizeEmail,
  otpMatches,
  verifyRegistrationToken,
} from "../services/clientRegistrationSecurity.js";
import {
  DOCUMENT_CATEGORIES,
  createDocumentConfirmationToken,
  createDocumentUpload,
  keyBelongsToOwner,
  validateDocumentInput,
  verifyDocumentConfirmationToken,
} from "../services/clientDocumentService.js";

const COMPANY_TYPES = ["Ship Owner", "Ship Manager", "Charterer", "Broker", "Bank", "Insurer", "Other"];
const SERVICE_NAMES = [
  "Condition Inspection",
  "Pre-Purchase Inspection",
  "Pre-Charter Inspection",
  "SIRE 2.0 Preparation",
  "RightShip Inspection",
  "ISM / ISPS / MLC Audit",
  "Flag-State Inspection",
  "Dry-Dock Attendance",
  "Technical Consultancy",
  "Marine Warranty or specialist surveys",
];

const emailValid = (email) => /^\S+@\S+\.\S+$/.test(email);
const clean = (value) => String(value ?? "").trim();
const optional = (value) => clean(value) || null;
const ttlSeconds = () => Math.max(60, Number(process.env.OTP_TTL_SECONDS) || 600);
const maxAttempts = () => Math.max(1, Number(process.env.OTP_MAX_ATTEMPTS) || 5);
const cooldownSeconds = () => Math.max(10, Number(process.env.OTP_RESEND_COOLDOWN_SECONDS) || 60);

const safeConfigurationError = (res, error) => {
  const configurationCodes = ["EMAIL_NOT_CONFIGURED", "OTP_NOT_CONFIGURED", "REGISTRATION_TOKEN_NOT_CONFIGURED"];
  if (configurationCodes.includes(error?.code) || /not configured/i.test(error?.message || "")) {
    return res.status(503).json({ success: false, code: "REGISTRATION_SERVICE_NOT_CONFIGURED", message: "Client email verification is not configured." });
  }
  return null;
};

export const requestClientEmailOtp = async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!emailValid(email)) return res.status(400).json({ success: false, message: "A valid email is required" });

  try {
    const existing = await pool.query(`SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1`, [email]);
    if (existing.rows.length) return res.status(409).json({ success: false, message: "An account with this email already exists." });

    const latest = await pool.query(
      `SELECT last_sent_at FROM email_verification_challenges WHERE normalized_email = $1 ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    if (latest.rows.length) {
      const elapsed = (Date.now() - new Date(latest.rows[0].last_sent_at).getTime()) / 1000;
      if (elapsed < cooldownSeconds()) {
        return res.status(429).json({ success: false, code: "OTP_COOLDOWN", retry_after_seconds: Math.ceil(cooldownSeconds() - elapsed), message: "Please wait before requesting another code." });
      }
    }

    const recent = await pool.query(
      `SELECT COUNT(*)::int AS total FROM email_verification_challenges WHERE (normalized_email = $1 OR request_ip = $2) AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 hour'`,
      [email, req.ip]
    );
    if (recent.rows[0].total >= 10) return res.status(429).json({ success: false, message: "Too many verification requests. Please try again later." });

    const draftId = crypto.randomUUID();
    const otp = createOtp();
    const digest = digestOtp({ email, draftId, otp });
    const inserted = await pool.query(
      `
      INSERT INTO email_verification_challenges
        (normalized_email, otp_digest, expires_at, attempt_count, max_attempts, last_sent_at, registration_draft_id, request_ip)
      VALUES ($1, $2, CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'), 0, $4, CURRENT_TIMESTAMP, $5, $6)
      RETURNING id
      `,
      [email, digest, ttlSeconds(), maxAttempts(), draftId, req.ip]
    );

    try {
      await sendClientRegistrationOtp({ email, otp });
    } catch (error) {
      await pool.query(`DELETE FROM email_verification_challenges WHERE id = $1`, [inserted.rows[0].id]);
      throw error;
    }

    return res.json({ success: true, message: "If the address is eligible, a verification code has been sent.", expires_in_seconds: ttlSeconds(), resend_after_seconds: cooldownSeconds() });
  } catch (error) {
    const configResponse = safeConfigurationError(res, error);
    if (configResponse) return configResponse;
    return res.status(500).json({ success: false, message: "Unable to send verification code." });
  }
};

export const verifyClientEmailOtp = async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const otp = clean(req.body?.otp);
  if (!emailValid(email) || !/^\d{6}$/.test(otp)) return res.status(400).json({ success: false, message: "Email and a six-digit code are required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT * FROM email_verification_challenges WHERE normalized_email = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [email]
    );
    const challenge = result.rows[0];
    if (!challenge || new Date(challenge.expires_at).getTime() <= Date.now()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, code: "OTP_EXPIRED", message: "The verification code is invalid or expired." });
    }
    if (challenge.attempt_count >= challenge.max_attempts) {
      await client.query("ROLLBACK");
      return res.status(429).json({ success: false, code: "OTP_ATTEMPTS_EXCEEDED", message: "Verification attempt limit reached." });
    }

    const candidate = digestOtp({ email, draftId: challenge.registration_draft_id, otp });
    if (!otpMatches({ expectedDigest: challenge.otp_digest, candidateDigest: candidate })) {
      await client.query(`UPDATE email_verification_challenges SET attempt_count = attempt_count + 1 WHERE id = $1`, [challenge.id]);
      await client.query("COMMIT");
      return res.status(400).json({ success: false, code: "OTP_INVALID", message: "The verification code is invalid or expired." });
    }

    await client.query(`UPDATE email_verification_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1`, [challenge.id]);
    await client.query("COMMIT");
    const registrationToken = createRegistrationToken({ email, draftId: challenge.registration_draft_id, challengeId: challenge.id });
    return res.json({ success: true, message: "Email verified successfully.", registrationToken });
  } catch (error) {
    await client.query("ROLLBACK");
    const configResponse = safeConfigurationError(res, error);
    if (configResponse) return configResponse;
    return res.status(500).json({ success: false, message: "Email verification failed." });
  } finally {
    client.release();
  }
};

const registrationIdentity = (req, res) => {
  try {
    return verifyRegistrationToken(getRegistrationBearer(req));
  } catch {
    res.status(401).json({ success: false, message: "A valid verified-email registration token is required." });
    return null;
  }
};

const activeRegistrationIdentity = async (req, res) => {
  const identity = registrationIdentity(req, res);
  if (!identity) return null;
  const result = await pool.query(
    `SELECT id FROM email_verification_challenges WHERE id=$1 AND registration_draft_id=$2 AND consumed_at IS NOT NULL AND registration_completed_at IS NULL`,
    [identity.challengeId, identity.draftId]
  );
  if (!result.rows.length) {
    res.status(409).json({ success: false, message: "This verified-email registration session is no longer active." });
    return null;
  }
  return identity;
};

export const presignClientRegistrationDocument = async (req, res) => {
  const identity = await activeRegistrationIdentity(req, res);
  if (!identity) return;
  const { category, contentType, size, originalFilename } = req.body || {};
  const validationError = validateDocumentInput({ category, contentType, size, originalFilename });
  if (validationError) return res.status(400).json({ success: false, message: validationError });
  try {
    const upload = createDocumentUpload({ ownerType: "drafts", ownerId: identity.draftId, category, contentType, size, originalFilename });
    return res.json({ success: true, uploadUrl: upload.uploadUrl, key: upload.key, expiresIn: upload.expiresIn });
  } catch {
    return res.status(503).json({ success: false, message: "Private document upload is not configured." });
  }
};

export const confirmClientRegistrationDocument = async (req, res) => {
  const identity = await activeRegistrationIdentity(req, res);
  if (!identity) return;
  const { key, category, contentType, size, originalFilename } = req.body || {};
  const validationError = validateDocumentInput({ category, contentType, size, originalFilename });
  if (validationError || !keyBelongsToOwner({ key, ownerType: "drafts", ownerId: identity.draftId, category, contentType })) {
    return res.status(400).json({ success: false, message: validationError || "Document key does not belong to this registration." });
  }
  const documentToken = createDocumentConfirmationToken({ draftId: identity.draftId, key, category, contentType, size: Number(size), originalFilename: clean(originalFilename) });
  return res.json({ success: true, documentToken, document: { category, originalFilename: clean(originalFilename), contentType, size: Number(size) } });
};

const validatePassword = (password) => typeof password === "string" && password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
const validImo = (value) => {
  if (!value) return true;
  const digits = String(value).replace(/^IMO\s*/i, "").replace(/\s/g, "");
  if (!/^\d{7}$/.test(digits)) return false;
  const total = digits.slice(0, 6).split("").reduce((sum, digit, index) => sum + Number(digit) * (7 - index), 0);
  return total % 10 === Number(digits[6]);
};

const generatedUsername = async (client, email) => {
  const base = email.split("@")[0].replace(/[^a-z0-9_]/gi, "").slice(0, 20) || "client";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const username = `${base}_${crypto.randomInt(1000, 10000)}`;
    const found = await client.query(`SELECT id FROM users WHERE username = $1`, [username]);
    if (!found.rows.length) return username;
  }
  throw new Error("Unable to create a unique username");
};

export const registerClient = async (req, res) => {
  const identity = registrationIdentity(req, res);
  if (!identity) return;
  const body = req.body || {};
  const company = body.company || {};
  const vessels = Array.isArray(body.vessels) ? body.vessels : [];
  const services = Array.isArray(body.services) ? body.services : [];
  const documentTokens = Array.isArray(body.documentTokens) ? body.documentTokens : [];
  const email = normalizeEmail(body.email);

  const requiredUser = clean(body.full_name) && clean(body.mobile_number) && clean(body.designation);
  const requiredCompany = clean(company.legal_name) && COMPANY_TYPES.includes(company.company_type) && clean(company.registered_address) && clean(company.country) && clean(company.registration_number) && clean(company.authorized_representative_name) && emailValid(normalizeEmail(company.authorized_representative_email)) && clean(company.authorized_representative_phone);
  if (!requiredUser || !requiredCompany || email !== identity.email || !validatePassword(body.password)) {
    return res.status(400).json({ success: false, message: "Registration details are incomplete or invalid. Passwords require at least eight characters with letters and numbers." });
  }
  if (!Number.isInteger(Number(body.declared_vessel_count)) || Number(body.declared_vessel_count) < 0) return res.status(400).json({ success: false, message: "Number of vessels must be zero or greater." });
  if (!services.length || services.some((service) => !SERVICE_NAMES.includes(clean(service.name)))) return res.status(400).json({ success: false, message: "Select at least one valid required service." });
  if (vessels.some((vessel) => !clean(vessel.vessel_name) || !clean(vessel.ownership_relationship) || !validImo(vessel.imo_number))) return res.status(400).json({ success: false, message: "One or more onboarding vessels are invalid." });

  let documents;
  try {
    documents = documentTokens.map(verifyDocumentConfirmationToken);
  } catch {
    return res.status(400).json({ success: false, message: "One or more document confirmations are invalid or expired." });
  }
  const categories = new Set(documents.filter((doc) => doc.draftId === identity.draftId).map((doc) => doc.category));
  if (documents.length !== DOCUMENT_CATEGORIES.length || categories.size !== DOCUMENT_CATEGORIES.length || DOCUMENT_CATEGORIES.some((category) => !categories.has(category))) return res.status(400).json({ success: false, message: "Upload exactly one current file for every required verification document." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const challengeResult = await client.query(
      `SELECT * FROM email_verification_challenges WHERE id = $1 AND registration_draft_id = $2 FOR UPDATE`,
      [identity.challengeId, identity.draftId]
    );
    const challenge = challengeResult.rows[0];
    if (!challenge || !challenge.consumed_at || challenge.registration_completed_at || normalizeEmail(challenge.normalized_email) !== email) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "This registration token has already been used or is invalid." });
    }
    const duplicate = await client.query(`SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1`, [email]);
    if (duplicate.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "An account with this email already exists." });
    }

    const username = await generatedUsername(client, email);
    const passwordHash = await bcrypt.hash(body.password, 10);
    const userResult = await client.query(
      `INSERT INTO users (full_name, email, username, password_hash, role_id, phone, is_active) VALUES ($1,$2,$3,$4,3,$5,true) RETURNING id, full_name, email, username, role_id, phone, is_active, created_at`,
      [clean(body.full_name), email, username, passwordHash, clean(body.mobile_number)]
    );
    const user = userResult.rows[0];
    const profileResult = await client.query(
      `INSERT INTO client_profiles (user_id, designation, declared_vessel_count, verification_status, verification_submitted_at) VALUES ($1,$2,$3,'pending',CURRENT_TIMESTAMP) RETURNING *`,
      [user.id, clean(body.designation), Number(body.declared_vessel_count)]
    );
    const profile = profileResult.rows[0];
    await client.query(
      `INSERT INTO client_companies (client_profile_id, legal_name, company_type, registered_address, country, registration_number, website, imo_company_number, tax_number, authorized_representative_name, authorized_representative_designation, authorized_representative_email, authorized_representative_phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [profile.id, clean(company.legal_name), company.company_type, clean(company.registered_address), clean(company.country), clean(company.registration_number), optional(company.website), optional(company.imo_company_number), optional(company.tax_number), clean(company.authorized_representative_name), optional(company.authorized_representative_designation), normalizeEmail(company.authorized_representative_email), clean(company.authorized_representative_phone)]
    );

    for (const vessel of vessels) {
      const typeId = Number(vessel.vessel_type_id) || null;
      if (typeId) {
        const typeExists = await client.query(`SELECT id FROM master_vessel_types WHERE id = $1`, [typeId]);
        if (!typeExists.rows.length) throw new Error("Invalid vessel type");
      }
      await client.query(
        `INSERT INTO client_onboarding_vessels (client_profile_id, vessel_name, imo_number, vessel_type_id, vessel_type_text, ownership_relationship, operating_regions) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [profile.id, clean(vessel.vessel_name), optional(vessel.imo_number)?.replace(/^IMO\s*/i, ""), typeId, optional(vessel.vessel_type_text), clean(vessel.ownership_relationship), optional(vessel.operating_regions)]
      );
    }

    for (const service of services) {
      const name = clean(service.name);
      const match = await client.query(
        `SELECT mst.id AS service_type_id, NULL::integer AS service_category_id FROM master_service_types mst WHERE LOWER(mst.name) = LOWER($1) UNION ALL SELECT msc.service_type_id, msc.id FROM master_service_categories msc WHERE LOWER(msc.name) = LOWER($1) LIMIT 1`,
        [name]
      );
      await client.query(
        `INSERT INTO client_required_services (client_profile_id, service_type_id, service_category_id, service_name_snapshot, other_service_text) VALUES ($1,$2,$3,$4,$5)`,
        [profile.id, match.rows[0]?.service_type_id || null, match.rows[0]?.service_category_id || null, name, optional(service.otherText)]
      );
    }

    for (const document of documents) {
      if (document.draftId !== identity.draftId || !keyBelongsToOwner({ key: document.key, ownerType: "drafts", ownerId: identity.draftId, category: document.category, contentType: document.contentType })) throw new Error("Invalid draft document");
      await client.query(
        `INSERT INTO client_verification_documents (client_profile_id, document_category, s3_key, original_filename, mime_type, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)`,
        [profile.id, document.category, document.key, document.originalFilename, document.contentType, document.size]
      );
    }
    await client.query(`INSERT INTO client_verification_events (client_profile_id, previous_status, new_status) VALUES ($1,NULL,'pending')`, [profile.id]);
    await client.query(`UPDATE email_verification_challenges SET registration_completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [challenge.id]);
    await client.query("COMMIT");

    const responseUser = { ...user, verification_status: "pending" };
    return res.status(201).json({ success: true, message: "Client registration submitted for verification.", token: createToken(responseUser), user: responseUser });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return res.status(409).json({ success: false, message: "Email, company registration number, IMO company number, or another unique value already exists." });
    return res.status(500).json({ success: false, message: "Client registration failed." });
  } finally {
    client.release();
  }
};
