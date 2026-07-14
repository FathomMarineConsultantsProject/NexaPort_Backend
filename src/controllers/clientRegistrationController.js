import bcrypt from "bcrypt";
import crypto from "crypto";
import { pool } from "../config/db.js";
import { createToken } from "./authController.js";
import {
  createRegistrationDraftToken,
  getRegistrationBearer,
  normalizeEmail,
  registrationDraftMatchesEmail,
  verifyRegistrationDraftToken,
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

const rateBuckets = new Map();
const consumeRateLimit = ({ scope, keys, limit, windowMs }) => {
  const now = Date.now();
  if (rateBuckets.size > 10_000) {
    for (const [key, timestamps] of rateBuckets) {
      const recent = timestamps.filter((timestamp) => now - timestamp < windowMs);
      if (recent.length) rateBuckets.set(key, recent);
      else rateBuckets.delete(key);
    }
  }
  for (const key of keys.filter(Boolean)) {
    const bucketKey = `${scope}:${key}`;
    const recent = (rateBuckets.get(bucketKey) || []).filter((timestamp) => now - timestamp < windowMs);
    if (recent.length >= limit) return false;
    recent.push(now);
    rateBuckets.set(bucketKey, recent);
  }
  return true;
};

export const createClientRegistrationDraft = async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!emailValid(email)) return res.status(400).json({ success: false, message: "A valid email is required." });
  if (!consumeRateLimit({ scope: "draft", keys: [`email:${email}`, `ip:${req.ip}`], limit: 10, windowMs: 60 * 60 * 1000 })) {
    return res.status(429).json({ success: false, message: "Too many registration requests. Please try again later." });
  }

  try {
    const existing = await pool.query(`SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1`, [email]);
    if (existing.rows.length) return res.status(409).json({ success: false, message: "An account with this email already exists." });
    const draftId = crypto.randomUUID();
    const registrationDraftToken = createRegistrationDraftToken({ email, draftId });
    return res.json({ success: true, registrationDraftToken, expiresIn: process.env.CLIENT_REGISTRATION_TOKEN_TTL || "60m" });
  } catch (error) {
    if (error?.code === "REGISTRATION_TOKEN_NOT_CONFIGURED") {
      return res.status(503).json({ success: false, code: "REGISTRATION_SERVICE_NOT_CONFIGURED", message: "Client registration is not configured." });
    }
    return res.status(500).json({ success: false, message: "Unable to start client registration." });
  }
};

const registrationIdentity = (req, res) => {
  try {
    return verifyRegistrationDraftToken(getRegistrationBearer(req));
  } catch {
    res.status(401).json({ success: false, message: "A valid registration draft token is required." });
    return null;
  }
};

export const presignClientRegistrationDocument = async (req, res) => {
  const identity = registrationIdentity(req, res);
  if (!identity) return;
  if (!consumeRateLimit({ scope: "upload", keys: [`draft:${identity.draftId}`, `ip:${req.ip}`], limit: 30, windowMs: 60 * 60 * 1000 })) {
    return res.status(429).json({ success: false, message: "Too many document upload requests. Please try again later." });
  }
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
  const identity = registrationIdentity(req, res);
  if (!identity) return;
  if (!consumeRateLimit({ scope: "confirm", keys: [`draft:${identity.draftId}`, `ip:${req.ip}`], limit: 60, windowMs: 60 * 60 * 1000 })) {
    return res.status(429).json({ success: false, message: "Too many document confirmation requests. Please try again later." });
  }
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
  if (!requiredUser || !requiredCompany || !registrationDraftMatchesEmail(identity, email) || !validatePassword(body.password)) {
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
