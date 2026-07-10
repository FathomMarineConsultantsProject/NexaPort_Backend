import bcrypt from "bcrypt";
import crypto from "crypto";
import { pool } from "../config/db.js";
import { createPresignedPutUrl } from "../utils/s3Presign.js";

const nameRegex = /^[A-Za-z\s'-]+$/;
const phoneRegex = /^[0-9+\-\s()]+$/;
const currentYear = () => new Date().getFullYear();

const requiredString = (body, key, label, errors) => {
  const value = typeof body[key] === "string" ? body[key].trim() : "";
  if (!value) errors.push(`${label} is required`);
  return value;
};

const optionalString = (body, key) =>
  typeof body[key] === "string" ? body[key].trim() : "";

const normalizeArray = (value) => (Array.isArray(value) ? value : []);

const normalizeObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const normalizeReferences = (refs) =>
  normalizeArray(refs)
    .map((ref) => ({
      name: String(ref?.name || "").trim(),
      email: String(ref?.email || "").trim(),
      phoneNumber: String(ref?.phoneNumber || "").trim(),
      position: String(ref?.position || "").trim(),
      companyName: String(ref?.companyName || "").trim(),
      ...(ref?.contact ? { contact: String(ref.contact).trim() } : {}),
    }))
    .filter((ref) =>
      Object.values(ref).some((value) => String(value || "").trim())
    );

const optionalTrimmedString = (value) => {
  const clean = String(value ?? "").trim();
  return clean || null;
};

const normalizeFlagServices = (body, errors) => {
  const providesFlagStateInspectionServices =
    typeof body.providesFlagStateInspectionServices === "boolean"
      ? body.providesFlagStateInspectionServices
      : body.providesFlagStateInspectionServices === "true";

  if (!providesFlagStateInspectionServices) {
    return {
      providesFlagStateInspectionServices: false,
      flagServices: [],
    };
  }

  if (!Array.isArray(body.flagServices) || body.flagServices.length === 0) {
    errors.push("Select at least one Flag served");
    return {
      providesFlagStateInspectionServices: true,
      flagServices: [],
    };
  }

  const seenFlagIds = new Set();
  const flagServices = [];

  body.flagServices.forEach((service) => {
    const flagId = Number(service?.flagId);
    if (!Number.isInteger(flagId) || flagId <= 0) {
      errors.push("Flag services must contain valid Flag IDs");
      return;
    }

    if (seenFlagIds.has(flagId)) {
      errors.push("Duplicate Flags are not allowed");
      return;
    }
    seenFlagIds.add(flagId);

    const coverageRows = normalizeArray(service?.coverage)
      .map((coverage) => ({
        country: optionalTrimmedString(coverage?.country),
        region: optionalTrimmedString(coverage?.region),
        location: optionalTrimmedString(coverage?.location),
        coverageNote: optionalTrimmedString(coverage?.coverageNote),
      }))
      .filter(
        (coverage) =>
          coverage.country ||
          coverage.region ||
          coverage.location ||
          coverage.coverageNote
      );

    if (!coverageRows.length) {
      errors.push("Each selected Flag requires at least one coverage area");
      return;
    }

    if (coverageRows.some((coverage) => !coverage.country)) {
      errors.push("Country is required for each Flag coverage area");
      return;
    }

    flagServices.push({
      flagId,
      coverage: coverageRows,
    });
  });

  return {
    providesFlagStateInspectionServices: true,
    flagServices,
  };
};

const normalizeSubmittedPorts = (ports, errors) => {
  if (!Array.isArray(ports)) {
    errors.push("Ports must be an array");
    return [];
  }

  const seen = new Set();
  const normalized = [];

  ports.forEach((port) => {
    if (typeof port !== "string") {
      errors.push("Ports must contain valid port names");
      return;
    }

    const clean = port.trim();
    if (!clean || clean.length > 200) {
      errors.push("Ports must contain valid port names");
      return;
    }

    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(clean);
    }
  });

  return normalized;
};

const validateCanonicalPorts = async (client, submittedPorts) => {
  if (!submittedPorts.length) return [];

  const normalizedNames = submittedPorts.map((port) => port.toLowerCase());
  const result = await client.query(
    `
    SELECT port_name
    FROM ports
    WHERE is_active = true
      AND LOWER(TRIM(port_name)) = ANY($1::text[])
    `,
    [normalizedNames]
  );

  const canonicalByName = new Map(
    result.rows.map((row) => [row.port_name.trim().toLowerCase(), row.port_name])
  );

  if (canonicalByName.size !== normalizedNames.length) {
    throw new Error("Every selected port must exist and be active");
  }

  return normalizedNames.map((name) => canonicalByName.get(name));
};

const validateActiveFlags = async (client, flagServices) => {
  if (!flagServices.length) return;

  const flagIds = flagServices.map((service) => service.flagId);
  const result = await client.query(
    `
    SELECT id
    FROM master_flag_states
    WHERE id = ANY($1::int[])
    `,
    [flagIds]
  );

  if (result.rows.length !== flagIds.length) {
    throw new Error("Every selected Flag must exist");
  }
};

const validateRegistrationPayload = (body) => {
  const errors = [];

  const data = {
    firstName: requiredString(body, "firstName", "First name", errors),
    lastName: requiredString(body, "lastName", "Last name", errors),
    phoneNumber: requiredString(body, "phoneNumber", "Phone number", errors),
    mobileNumber: optionalString(body, "mobileNumber"),
    nationality: requiredString(body, "nationality", "Nationality", errors),
    employmentStatus: requiredString(
      body,
      "employmentStatus",
      "Employment status",
      errors
    ),
    companyName: optionalString(body, "companyName"),

    email: requiredString(body, "email", "Email", errors).toLowerCase(),
    username: requiredString(body, "username", "Username", errors),
    password: typeof body.password === "string" ? body.password : "",

    dobDD: requiredString(body, "dobDD", "DOB day", errors),
    dobMM: requiredString(body, "dobMM", "DOB month", errors),
    dobYYYY: requiredString(body, "dobYYYY", "DOB year", errors),
    yearStarted: optionalString(body, "yearStarted"),
    heardAbout: requiredString(body, "heardAbout", "How you heard about us", errors),

    street1: requiredString(body, "street1", "Street address 1", errors),
    street2: optionalString(body, "street2"),
    city: requiredString(body, "city", "City", errors),
    postalCode: requiredString(body, "postalCode", "Postal code", errors),
    country: requiredString(body, "country", "Country", errors),
    stateRegion: requiredString(body, "stateRegion", "State/Region", errors),

    discipline: requiredString(body, "discipline", "Discipline", errors),
    rank: requiredString(body, "rank", "Rank", errors),

    qualifications: normalizeArray(body.qualifications),
    experienceByQualification: normalizeObject(body.experienceByQualification),
    vesselTypes: normalizeArray(body.vesselTypes),
    ports: normalizeSubmittedPorts(body.ports, errors),
    shoresideExperience: normalizeArray(body.shoresideExperience),
    surveyingExperience: normalizeArray(body.surveyingExperience),
    vesselTypeSurveyingExperience: normalizeArray(
      body.vesselTypeSurveyingExperience
    ),
    accreditations: normalizeArray(body.accreditations),
    coursesCompleted: normalizeArray(body.coursesCompleted),

    disciplineOther: optionalString(body, "disciplineOther"),
    rankOther: optionalString(body, "rankOther"),
    qualificationsOther: optionalString(body, "qualificationsOther"),
    vesselTypesOther: optionalString(body, "vesselTypesOther"),
    shoresideExperienceOther: optionalString(body, "shoresideExperienceOther"),
    surveyingExperienceOther: optionalString(body, "surveyingExperienceOther"),
    vesselTypeSurveyingExperienceOther: optionalString(
      body,
      "vesselTypeSurveyingExperienceOther"
    ),
    accreditationsOther: optionalString(body, "accreditationsOther"),
    coursesCompletedOther: optionalString(body, "coursesCompletedOther"),

    references: normalizeReferences(body.references),
    inspectionCost: requiredString(body, "inspectionCost", "Inspection cost", errors),
    marketingConsent:
      typeof body.marketingConsent === "boolean"
        ? body.marketingConsent
        : body.marketingConsent === "true",
    photoS3Key: requiredString(body, "photoS3Key", "Profile photo", errors),
    cvS3Key: requiredString(body, "cvS3Key", "CV file", errors),
  };

  const flagServiceData = normalizeFlagServices(body, errors);
  data.providesFlagStateInspectionServices =
    flagServiceData.providesFlagStateInspectionServices;
  data.flagServices = flagServiceData.flagServices;

  if (!data.password) errors.push("Password is required");
  if (data.password && data.password.length < 6) {
    errors.push("Password must be at least 6 characters");
  }
  if (data.firstName && !nameRegex.test(data.firstName)) {
    errors.push("First name must contain letters only");
  }
  if (data.lastName && !nameRegex.test(data.lastName)) {
    errors.push("Last name must contain letters only");
  }
  if (data.phoneNumber && !phoneRegex.test(data.phoneNumber)) {
    errors.push("Phone number is invalid");
  }
  if (data.mobileNumber && !phoneRegex.test(data.mobileNumber)) {
    errors.push("Mobile number is invalid");
  }
  if (data.email && !/^\S+@\S+\.\S+$/.test(data.email)) {
    errors.push("Email is invalid");
  }
  if (
    ["employee", "owner"].includes(data.employmentStatus) &&
    !data.companyName
  ) {
    errors.push("Company name is required");
  }
  if (!data.qualifications.length) {
    errors.push("Select at least one qualification");
  }
  if (!data.vesselTypes.length) {
    errors.push("Select at least one vessel type");
  }

  const dd = Number(data.dobDD);
  const mm = Number(data.dobMM);
  const yy = Number(data.dobYYYY);
  if (!Number.isInteger(dd) || dd < 1 || dd > 31) errors.push("DOB day is invalid");
  if (!Number.isInteger(mm) || mm < 1 || mm > 12) errors.push("DOB month is invalid");
  if (!Number.isInteger(yy) || yy < 1900 || yy > currentYear()) {
    errors.push("DOB year is invalid");
  }

  if (data.yearStarted) {
    const started = Number(data.yearStarted);
    if (
      !Number.isInteger(started) ||
      started < 1900 ||
      started > currentYear()
    ) {
      errors.push("Year started must be a valid year");
    }
  }

  for (const qualification of data.qualifications) {
    const exp = data.experienceByQualification[qualification];
    if (!exp || (!exp.years && !exp.months && !exp.days)) {
      errors.push(`Experience is required for ${qualification}`);
    }
  }

  if (body.references !== undefined && !Array.isArray(body.references)) {
    errors.push("References must be an array");
  }

  data.references.forEach((ref, index) => {
    if (!ref.name) errors.push(`Reference ${index + 1} name is required`);
    if (!ref.email && !ref.phoneNumber) {
      errors.push(`Reference ${index + 1} email or phone is required`);
    }
    if (ref.email && !/^\S+@\S+\.\S+$/.test(ref.email)) {
      errors.push(`Reference ${index + 1} email is invalid`);
    }
  });

  return { data, errors };
};

const calculateYearsExperience = (yearStarted) => {
  if (!yearStarted) return null;
  const year = Number(yearStarted);
  if (!Number.isInteger(year) || year < 1900 || year > currentYear()) return null;
  return Math.max(0, currentYear() - year);
};

const buildBaseLocation = (city, stateRegion) =>
  [city, stateRegion].map((part) => part.trim()).filter(Boolean).join(", ") ||
  null;

export const presignConsultantUpload = async (req, res) => {
  try {
    const { kind, contentType, size } = req.body || {};
    const byteSize = Number(size);
    const isPhoto = kind === "photo";
    const isCv = kind === "cv";

    if (!isPhoto && !isCv) {
      return res.status(400).json({ success: false, message: "Invalid upload kind" });
    }
    if (!contentType || typeof contentType !== "string") {
      return res.status(400).json({ success: false, message: "contentType is required" });
    }
    if (!Number.isFinite(byteSize) || byteSize <= 0) {
      return res.status(400).json({ success: false, message: "File size is required" });
    }
    if (isPhoto && !contentType.startsWith("image/")) {
      return res.status(400).json({ success: false, message: "Photo must be image/*" });
    }
    if (isPhoto && byteSize > 3 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: "Photo must be 3MB or less" });
    }
    if (isCv && contentType !== "application/pdf") {
      return res.status(400).json({ success: false, message: "CV must be PDF" });
    }
    if (isCv && byteSize > 5 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: "CV must be 5MB or less" });
    }

    const id = crypto.randomUUID();
    const key = isPhoto
      ? `consultant-registrations/photos/${id}.img`
      : `consultant-registrations/cvs/${id}.pdf`;

    const uploadUrl = createPresignedPutUrl({ key, contentType });
    return res.json({ success: true, key, uploadUrl });
  } catch (error) {
    console.error("Consultant upload presign failed", {
      name: error?.name,
      message: error?.message,
      code: error?.code,
      metadata: error?.$metadata,
    });
    return res.status(500).json({
      success: false,
      message: "Failed to create upload URL",
    });
  }
};

export const registerConsultant = async (req, res) => {
  const { data, errors } = validateRegistrationPayload(req.body || {});
  if (errors.length) {
    return res.status(400).json({ success: false, message: errors[0], errors });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existingEmail = await client.query(
      `SELECT id FROM users WHERE email = $1 LIMIT 1`,
      [data.email]
    );
    if (existingEmail.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists.",
      });
    }

    const existingUsername = await client.query(
      `SELECT id FROM users WHERE username = $1 LIMIT 1`,
      [data.username]
    );
    if (existingUsername.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "This username is already in use.",
      });
    }

    const fullName = `${data.firstName} ${data.lastName}`.replace(/\s+/g, " ").trim();
    const passwordHash = await bcrypt.hash(data.password, 10);

    const userResult = await client.query(
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
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id, full_name, email, username, role_id, phone, is_active, created_at
      `,
      [
        fullName,
        data.email,
        data.username,
        passwordHash,
        2,
        data.phoneNumber || null,
        true,
      ]
    );

    const user = userResult.rows[0];

    const expertResult = await client.query(
      `
      INSERT INTO experts (
        user_id,
        full_name,
        biography,
        base_location,
        country,
        years_experience,
        availability,
        is_premium
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
      `,
      [
        user.id,
        fullName,
        "Consultant registration submitted through NexaPort.",
        buildBaseLocation(data.city, data.stateRegion),
        data.country,
        calculateYearsExperience(data.yearStarted),
        "available",
        false,
      ]
    );

    const expert = expertResult.rows[0];

    const canonicalPorts = await validateCanonicalPorts(client, data.ports);
    await validateActiveFlags(client, data.flagServices);

    for (const portName of canonicalPorts) {
      await client.query(
        `INSERT INTO expert_ports (expert_id, port_name) VALUES ($1, $2)`,
        [expert.id, portName]
      );
    }

    for (const flagService of data.flagServices) {
      const expertFlagResult = await client.query(
        `
        INSERT INTO expert_flags (expert_id, flag_id, is_active)
        VALUES ($1, $2, true)
        RETURNING id
        `,
        [expert.id, flagService.flagId]
      );

      const expertFlagId = expertFlagResult.rows[0].id;

      for (const coverage of flagService.coverage) {
        await client.query(
          `
          INSERT INTO expert_flag_coverage (
            expert_flag_id,
            country,
            region,
            location,
            coverage_note,
            is_active
          )
          VALUES ($1, $2, $3, $4, $5, true)
          `,
          [
            expertFlagId,
            coverage.country,
            coverage.region,
            coverage.location,
            coverage.coverageNote,
          ]
        );
      }
    }

    await client.query(
      `
      INSERT INTO expert_registration_details (
        user_id, expert_id,
        first_name, last_name, phone_number, mobile_number, nationality, employment_status, company_name, email,
        dob_dd, dob_mm, dob_yyyy, year_started, heard_about,
        street1, street2, city, postal_code, country, state_region,
        discipline, rank,
        discipline_other, rank_other, qualifications_other, vessel_types_other, shoreside_experience_other,
        surveying_experience_other, vessel_type_surveying_experience_other, accreditations_other, courses_completed_other,
        qualifications, experience_by_qualification, vessel_types, shoreside_experience, surveying_experience,
        vessel_type_surveying_experience, accreditations, courses_completed, refs,
        inspection_cost, marketing_consent, photo_s3_key, cv_s3_key
      )
      VALUES (
        $1,$2,
        $3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,
        $16,$17,$18,$19,$20,$21,
        $22,$23,
        $24,$25,$26,$27,$28,
        $29,$30,$31,$32,
        $33::jsonb,$34::jsonb,$35::jsonb,$36::jsonb,$37::jsonb,
        $38::jsonb,$39::jsonb,$40::jsonb,$41::jsonb,
        $42,$43,$44,$45
      )
      RETURNING id
      `,
      [
        user.id,
        expert.id,
        data.firstName,
        data.lastName,
        data.phoneNumber,
        data.mobileNumber || null,
        data.nationality,
        data.employmentStatus,
        data.companyName || null,
        data.email,
        data.dobDD,
        data.dobMM,
        data.dobYYYY,
        data.yearStarted || null,
        data.heardAbout,
        data.street1,
        data.street2 || null,
        data.city,
        data.postalCode,
        data.country,
        data.stateRegion,
        data.discipline,
        data.rank,
        data.disciplineOther || null,
        data.rankOther || null,
        data.qualificationsOther || null,
        data.vesselTypesOther || null,
        data.shoresideExperienceOther || null,
        data.surveyingExperienceOther || null,
        data.vesselTypeSurveyingExperienceOther || null,
        data.accreditationsOther || null,
        data.coursesCompletedOther || null,
        JSON.stringify(data.qualifications),
        JSON.stringify(data.experienceByQualification),
        JSON.stringify(data.vesselTypes),
        JSON.stringify(data.shoresideExperience),
        JSON.stringify(data.surveyingExperience),
        JSON.stringify(data.vesselTypeSurveyingExperience),
        JSON.stringify(data.accreditations),
        JSON.stringify(data.coursesCompleted),
        JSON.stringify(data.references),
        data.inspectionCost,
        data.marketingConsent,
        data.photoS3Key,
        data.cvS3Key,
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Consultant registration completed successfully.",
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        username: user.username,
        role_id: user.role_id,
        is_active: user.is_active,
      },
      expert: {
        id: expert.id,
        user_id: expert.user_id,
        full_name: expert.full_name,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({
      success: false,
      message: "Consultant registration failed",
    });
  } finally {
    client.release();
  }
};
