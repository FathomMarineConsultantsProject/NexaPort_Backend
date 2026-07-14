import { pool } from "../config/db.js";
import {
  createDocumentUpload,
  keyBelongsToOwner,
  publicDocument,
  validateDocumentInput,
} from "../services/clientDocumentService.js";
import { normalizeEmail } from "../services/clientRegistrationSecurity.js";

const clean = (value) => String(value ?? "").trim();
const optional = (value) => clean(value) || null;
const COMPANY_TYPES = ["Ship Owner", "Ship Manager", "Charterer", "Broker", "Bank", "Insurer", "Other"];
const SERVICE_NAMES = ["Condition Inspection", "Pre-Purchase Inspection", "Pre-Charter Inspection", "SIRE 2.0 Preparation", "RightShip Inspection", "ISM / ISPS / MLC Audit", "Flag-State Inspection", "Dry-Dock Attendance", "Technical Consultancy", "Marine Warranty or specialist surveys"];
const validImo = (value) => {
  if (!clean(value)) return true;
  const digits = clean(value).replace(/^IMO\s*/i, "").replace(/\s/g, "");
  if (!/^\d{7}$/.test(digits)) return false;
  const total = digits.slice(0, 6).split("").reduce((sum, digit, index) => sum + Number(digit) * (7 - index), 0);
  return total % 10 === Number(digits[6]);
};

const getProfile = async (queryable, userId, lock = false) => {
  const result = await queryable.query(
    `SELECT cp.* FROM client_profiles cp WHERE cp.user_id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [userId]
  );
  return result.rows[0] || null;
};

const getOnboardingData = async (queryable, profile) => {
  const [company, vessels, services, documents, events] = await Promise.all([
    queryable.query(`SELECT * FROM client_companies WHERE client_profile_id = $1`, [profile.id]),
    queryable.query(`SELECT cov.*, mvt.name AS vessel_type_name FROM client_onboarding_vessels cov LEFT JOIN master_vessel_types mvt ON mvt.id = cov.vessel_type_id WHERE cov.client_profile_id = $1 ORDER BY cov.id`, [profile.id]),
    queryable.query(`SELECT id, service_type_id, service_category_id, service_name_snapshot, other_service_text, created_at FROM client_required_services WHERE client_profile_id = $1 ORDER BY id`, [profile.id]),
    queryable.query(`SELECT id, document_category, original_filename, mime_type, size_bytes, is_current, uploaded_at FROM client_verification_documents WHERE client_profile_id = $1 AND is_current = TRUE ORDER BY document_category`, [profile.id]),
    queryable.query(`SELECT previous_status, new_status, public_reason, created_at FROM client_verification_events WHERE client_profile_id = $1 ORDER BY created_at DESC`, [profile.id]),
  ]);
  const { verification_notes, verified_by_user_id, ...safeProfile } = profile;
  return {
    profile: safeProfile,
    company: company.rows[0] || null,
    vessels: vessels.rows,
    services: services.rows,
    documents: documents.rows.map(publicDocument),
    history: events.rows,
  };
};

export const getMyClientOnboarding = async (req, res) => {
  try {
    const profile = await getProfile(pool, req.user.id);
    if (!profile) return res.status(404).json({ success: false, verification_status: "missing", message: "Client onboarding profile not found." });
    return res.json({ success: true, data: await getOnboardingData(pool, profile) });
  } catch {
    return res.status(500).json({ success: false, message: "Failed to load Client registration." });
  }
};

export const updateMyClientOnboarding = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const profile = await getProfile(client, req.user.id, true);
    if (!profile) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Client onboarding profile not found." });
    }
    if (!['pending', 'rejected'].includes(profile.verification_status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "Approved registrations cannot be edited through onboarding." });
    }

    const { designation, declared_vessel_count: declaredCount, company, vessels, services } = req.body || {};
    if (designation !== undefined || declaredCount !== undefined) {
      const count = declaredCount === undefined ? null : Number(declaredCount);
      if (count !== null && (!Number.isInteger(count) || count < 0)) throw new Error("Invalid declared vessel count");
      await client.query(
        `UPDATE client_profiles SET designation = COALESCE($1, designation), declared_vessel_count = COALESCE($2, declared_vessel_count) WHERE id = $3`,
        [designation === undefined ? null : clean(designation), count, profile.id]
      );
    }

    if (company !== undefined) {
      if (!company || !clean(company.legal_name) || !COMPANY_TYPES.includes(company.company_type) || !clean(company.registered_address) || !clean(company.country) || !clean(company.registration_number) || !clean(company.authorized_representative_name) || !/^\S+@\S+\.\S+$/.test(normalizeEmail(company.authorized_representative_email)) || !clean(company.authorized_representative_phone)) {
        throw new Error("Company details are incomplete or invalid");
      }
      await client.query(
        `INSERT INTO client_companies (client_profile_id, legal_name, company_type, registered_address, country, registration_number, website, imo_company_number, tax_number, authorized_representative_name, authorized_representative_designation, authorized_representative_email, authorized_representative_phone) VALUES ($13,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (client_profile_id) DO UPDATE SET legal_name=EXCLUDED.legal_name, company_type=EXCLUDED.company_type, registered_address=EXCLUDED.registered_address, country=EXCLUDED.country, registration_number=EXCLUDED.registration_number, website=EXCLUDED.website, imo_company_number=EXCLUDED.imo_company_number, tax_number=EXCLUDED.tax_number, authorized_representative_name=EXCLUDED.authorized_representative_name, authorized_representative_designation=EXCLUDED.authorized_representative_designation, authorized_representative_email=EXCLUDED.authorized_representative_email, authorized_representative_phone=EXCLUDED.authorized_representative_phone`,
        [clean(company.legal_name), company.company_type, clean(company.registered_address), clean(company.country), clean(company.registration_number), optional(company.website), optional(company.imo_company_number), optional(company.tax_number), clean(company.authorized_representative_name), optional(company.authorized_representative_designation), normalizeEmail(company.authorized_representative_email), clean(company.authorized_representative_phone), profile.id]
      );
    }

    if (vessels !== undefined) {
      if (!Array.isArray(vessels)) throw new Error("Vessels must be an array");
      await client.query(`DELETE FROM client_onboarding_vessels WHERE client_profile_id = $1 AND converted_vessel_id IS NULL`, [profile.id]);
      for (const vessel of vessels) {
        if (!clean(vessel.vessel_name) || !clean(vessel.ownership_relationship) || !validImo(vessel.imo_number)) throw new Error("Vessel details are incomplete or contain an invalid IMO number");
        await client.query(
          `INSERT INTO client_onboarding_vessels (client_profile_id, vessel_name, imo_number, vessel_type_id, vessel_type_text, ownership_relationship, operating_regions) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [profile.id, clean(vessel.vessel_name), optional(vessel.imo_number), Number(vessel.vessel_type_id) || null, optional(vessel.vessel_type_text), clean(vessel.ownership_relationship), optional(vessel.operating_regions)]
        );
      }
    }

    if (services !== undefined) {
      if (!Array.isArray(services) || !services.length) throw new Error("At least one required service is required");
      await client.query(`DELETE FROM client_required_services WHERE client_profile_id = $1`, [profile.id]);
      for (const service of services) {
        if (!SERVICE_NAMES.includes(clean(service.name))) throw new Error("Invalid required service");
        const match = await client.query(`SELECT mst.id AS service_type_id, NULL::integer AS service_category_id FROM master_service_types mst WHERE LOWER(mst.name)=LOWER($1) UNION ALL SELECT msc.service_type_id, msc.id FROM master_service_categories msc WHERE LOWER(msc.name)=LOWER($1) LIMIT 1`, [clean(service.name)]);
        await client.query(
          `INSERT INTO client_required_services (client_profile_id, service_type_id, service_category_id, service_name_snapshot, other_service_text) VALUES ($1,$2,$3,$4,$5)`,
          [profile.id, match.rows[0]?.service_type_id || null, match.rows[0]?.service_category_id || null, clean(service.name), optional(service.otherText)]
        );
      }
    }

    await client.query("COMMIT");
    const refreshed = await getProfile(pool, req.user.id);
    return res.json({ success: true, message: "Client registration updated.", data: await getOnboardingData(pool, refreshed) });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return res.status(409).json({ success: false, message: "Company registration or IMO company number already exists." });
    return res.status(400).json({ success: false, message: error.message || "Failed to update Client registration." });
  } finally {
    client.release();
  }
};

export const presignMyClientDocument = async (req, res) => {
  const { category, contentType, size, originalFilename } = req.body || {};
  const validationError = validateDocumentInput({ category, contentType, size, originalFilename });
  if (validationError) return res.status(400).json({ success: false, message: validationError });
  try {
    const profile = await getProfile(pool, req.user.id);
    if (!profile || !['pending', 'rejected'].includes(profile.verification_status)) return res.status(409).json({ success: false, message: "Documents cannot be changed for this registration." });
    const upload = createDocumentUpload({ ownerType: "clients", ownerId: profile.id, category, contentType, size, originalFilename });
    return res.json({ success: true, uploadUrl: upload.uploadUrl, key: upload.key, expiresIn: upload.expiresIn });
  } catch {
    return res.status(503).json({ success: false, message: "Private document upload is not configured." });
  }
};

export const confirmMyClientDocument = async (req, res) => {
  const { key, category, contentType, size, originalFilename } = req.body || {};
  const validationError = validateDocumentInput({ category, contentType, size, originalFilename });
  if (validationError) return res.status(400).json({ success: false, message: validationError });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const profile = await getProfile(client, req.user.id, true);
    if (!profile || !['pending', 'rejected'].includes(profile.verification_status)) throw new Error("Documents cannot be changed for this registration.");
    if (!keyBelongsToOwner({ key, ownerType: "clients", ownerId: profile.id, category, contentType })) throw new Error("Document key does not belong to this Client.");
    const previous = await client.query(`SELECT id FROM client_verification_documents WHERE client_profile_id=$1 AND document_category=$2 AND is_current=TRUE FOR UPDATE`, [profile.id, category]);
    await client.query(`UPDATE client_verification_documents SET is_current=FALSE WHERE client_profile_id=$1 AND document_category=$2 AND is_current=TRUE`, [profile.id, category]);
    const inserted = await client.query(
      `INSERT INTO client_verification_documents (client_profile_id, document_category, s3_key, original_filename, mime_type, size_bytes, replaces_document_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, document_category, original_filename, mime_type, size_bytes, is_current, uploaded_at`,
      [profile.id, category, key, clean(originalFilename), contentType, Number(size), previous.rows[0]?.id || null]
    );
    await client.query("COMMIT");
    return res.status(201).json({ success: true, message: "Verification document replaced.", document: publicDocument(inserted.rows[0]) });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(400).json({ success: false, message: error.message || "Document confirmation failed." });
  } finally {
    client.release();
  }
};

export const resubmitMyClientOnboarding = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const profile = await getProfile(client, req.user.id, true);
    if (!profile) throw new Error("Client onboarding profile not found.");
    if (profile.verification_status !== "rejected") throw new Error("Only rejected registrations may be resubmitted.");
    await client.query(
      `UPDATE client_profiles SET verification_status='pending', verification_submitted_at=CURRENT_TIMESTAMP, rejection_reason=NULL, resubmission_count=resubmission_count+1 WHERE id=$1`,
      [profile.id]
    );
    await client.query(
      `INSERT INTO client_verification_events (client_profile_id, previous_status, new_status, actor_user_id, public_reason) VALUES ($1,'rejected','pending',$2,$3)`,
      [profile.id, req.user.id, profile.rejection_reason]
    );
    await client.query("COMMIT");
    return res.json({ success: true, message: "Registration resubmitted for verification.", verification_status: "pending" });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(409).json({ success: false, message: error.message || "Registration could not be resubmitted." });
  } finally {
    client.release();
  }
};
