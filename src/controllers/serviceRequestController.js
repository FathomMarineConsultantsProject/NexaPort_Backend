import { pool } from "../config/db.js";
import { findOrCreatePort } from "../utils/findOrCreatePort.js";
import { deleteServiceRequestById } from "../services/serviceRequestService.js";
import { createServiceRequestApprovedNotifications } from "../services/adminNotificationService.js";
import { writeAdminAudit } from "../services/adminAuditService.js";

const SERVICE_TYPES = new Set(["Audit", "Inspection", "Survey", "Other"]);

const validateServiceSelection = ({ serviceType, serviceCategory, serviceTypeOther }) => {
  const normalizedType = typeof serviceType === "string" ? serviceType.trim() : "";
  const normalizedCategory = typeof serviceCategory === "string" ? serviceCategory.trim() : "";
  const normalizedOther = typeof serviceTypeOther === "string" ? serviceTypeOther.trim() : "";
  const fieldErrors = {};

  if (!SERVICE_TYPES.has(normalizedType)) {
    fieldErrors.serviceType = "Select a valid service type.";
  }

  if (normalizedType === "Other") {
    if (!normalizedOther) {
      fieldErrors.serviceTypeOther = "Please describe the required service.";
    } else if (normalizedOther.length < 3) {
      fieldErrors.serviceTypeOther = "Service details must be at least 3 characters.";
    } else if (normalizedOther.length > 500) {
      fieldErrors.serviceTypeOther = "Service details must be 500 characters or fewer.";
    }
  } else if (SERVICE_TYPES.has(normalizedType) && (!normalizedCategory || normalizedCategory === "Other")) {
    fieldErrors.serviceCategory = "Select a valid service category.";
  }

  return {
    fieldErrors,
    serviceType: normalizedType,
    serviceCategory: normalizedType === "Other" ? "Other" : normalizedCategory,
    serviceTypeOther: normalizedType === "Other" ? normalizedOther : null,
  };
};

const sendValidationError = (res, fieldErrors) => res.status(400).json({
  success: false,
  code: "SERVICE_REQUEST_VALIDATION_FAILED",
  message: "Please correct the highlighted fields.",
  field_errors: fieldErrors,
});

const serviceSummary = (request) => {
  if (request.service_type !== "Other") {
    return String(request.service_category || request.service_type || "").trim();
  }
  const details = String(request.service_type_other || "").trim();
  return details ? `Other: ${details.slice(0, 120)}` : "Other";
};

const mapRequestRow = (row) => ({
  id: row.id,
  serviceType: row.service_type,
  serviceCategory: row.service_category,
  serviceTypeOther: row.service_type_other ?? null,
  title: row.title,
  scopeOfWork: row.scope_of_work,
  urgency: row.urgency,
  budgetUsd: Number(row.budget_usd || 0),
  requiredBy: row.required_by,
  requesterName: row.requester_name,
  requesterUserId: row.requester_user_id,
  status: row.status,
  moderationStatus: row.moderation_status,
  approvedAt: row.approved_at,
  approvedByUserId: row.approved_by_user_id,
  quotationCount: Number(row.quotation_count || 0),
  acceptedQuotationId: row.accepted_quotation_id,
  acceptedExpertId: row.accepted_expert_id,

  vessel: {
    name: row.vessel_name,
    imoNumber: row.imo_number,
    type: row.vessel_type,
    flagState: row.flag_state,
  },

  port: {
    id: row.port_id,
    name: row.port_name,
    country: row.country,
    eta: row.eta,
    locationSummary: row.location_summary,
  },

  requiredCertification: row.required_certification,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const serializeApprovedServiceRequestForConsultant = (row) => ({
  id: row.id,
  serviceType: row.service_type,
  serviceTypeOther: row.service_type_other ?? null,
  inspectionType: row.inspection_type,
  vesselType: row.vessel_type,
  inspectionDate: row.inspection_date,
  portOfInspection: row.port_of_inspection,
});

const serializeServiceRequestForAdmin = mapRequestRow;
const serializeServiceRequestForClient = mapRequestRow;

const canAccessRequest = async (user, request) => {
  const roleId = Number(user.role_id);

  if (roleId === 1) return true;

  if (roleId === 3) {
    return Number(request.requester_user_id) === Number(user.id);
  }

  if (roleId === 2) {
    return ["open", "pending", "active"].includes(
      String(request.status || "").toLowerCase()
    );
  }

  return false;
};

export const createServiceRequest = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      serviceType,
      serviceCategory,
      serviceTypeOther,
      title,
      scopeOfWork,
      urgency,
      budgetUsd,
      requiredBy,
      requesterName,
      vesselName,
      imoNumber,
      vesselType,
      flagState,
      portName,
      country,
      eta,
      locationSummary,
      requiredCertification,
    } = req.body;

    const serviceSelection = validateServiceSelection({ serviceType, serviceCategory, serviceTypeOther });
    const fieldErrors = { ...serviceSelection.fieldErrors };
    if (!String(title || "").trim()) fieldErrors.title = "Request title is required.";
    if (!String(scopeOfWork || "").trim()) fieldErrors.scopeOfWork = "Scope of work is required.";
    if (Object.keys(fieldErrors).length) {
      return sendValidationError(res, fieldErrors);
    }

    await client.query("BEGIN");

    let portId = null;

    if (portName && country) {
      const port = await findOrCreatePort({
        port_name: portName,
        country,
        region: locationSummary || null,
      });

      portId = port.id;
    }

    const result = await client.query(
      `
      INSERT INTO service_requests (
        service_type,
        service_category,
        service_type_other,
        title,
        scope_of_work,
        urgency,
        budget_usd,
        required_by,
        requester_name,
        vessel_name,
        imo_number,
        vessel_type,
        flag_state,
        port_id,
        port_name,
        country,
        eta,
        location_summary,
        required_certification,
        requester_user_id,
        moderation_status,
        status
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        $9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
      )
      RETURNING *
      `,
      [
        serviceSelection.serviceType,
        serviceSelection.serviceCategory,
        serviceSelection.serviceTypeOther,
        String(title).trim(),
        String(scopeOfWork).trim(),
        urgency || "routine",
        budgetUsd || null,
        requiredBy || null,
        requesterName || req.user.full_name || null,
        vesselName || null,
        imoNumber || null,
        vesselType || null,
        flagState || null,
        portId,
        portName || null,
        country || null,
        eta || null,
        locationSummary || null,
        requiredCertification || null,
        req.user.id,
        "pending",
        "open",
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Service request created successfully",
      data: mapRequestRow(result.rows[0]),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Create service request error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to create service request",
    });
  } finally {
    client.release();
  }
};

export const getServiceRequests = async (req, res) => {
  try {
    const { search, type, status, urgency, moderation } = req.query;

    if (Number(req.user.role_id) === 2) {
      const conditions = [
        `sr.moderation_status = 'approved'`,
        `LOWER(sr.status) IN ('open', 'pending', 'active')`,
      ];
      const values = [];

      if (search) {
        values.push(`%${search}%`);
        conditions.push(`(
          sr.service_category ILIKE $${values.length}
          OR sr.service_type ILIKE $${values.length}
          OR sr.service_type_other ILIKE $${values.length}
          OR sr.vessel_type ILIKE $${values.length}
          OR sr.port_name ILIKE $${values.length}
        )`);
      }
      if (type && type !== "all") {
        values.push(type);
        conditions.push(`LOWER(sr.service_type) = LOWER($${values.length})`);
      }

      const result = await pool.query(
        `
        SELECT
          sr.id,
          sr.service_type,
          sr.service_type_other,
          CASE
            WHEN sr.service_type = 'Other' THEN CONCAT('Other — ', sr.service_type_other)
            ELSE COALESCE(NULLIF(TRIM(sr.service_category), ''), NULLIF(TRIM(sr.service_type), ''))
          END AS inspection_type,
          sr.vessel_type,
          sr.required_by AS inspection_date,
          sr.port_name AS port_of_inspection
        FROM service_requests sr
        WHERE ${conditions.join(" AND ")}
        ORDER BY sr.required_by ASC NULLS LAST, sr.id DESC
        `,
        values
      );

      return res.json({
        success: true,
        data: result.rows.map(serializeApprovedServiceRequestForConsultant),
      });
    }

    const conditions = [];
    const values = [];

    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(
        sr.title ILIKE $${values.length}
        OR sr.port_name ILIKE $${values.length}
        OR sr.vessel_name ILIKE $${values.length}
        OR sr.service_category ILIKE $${values.length}
        OR sr.service_type ILIKE $${values.length}
        OR sr.service_type_other ILIKE $${values.length}
        OR sr.scope_of_work ILIKE $${values.length}
      )`);
    }

    if (type && type !== "all") {
      values.push(type);
      conditions.push(`LOWER(sr.service_type) = LOWER($${values.length})`);
    }

    if (status && status !== "all") {
      values.push(status);
      conditions.push(`LOWER(sr.status) = LOWER($${values.length})`);
    }

    if (urgency && urgency !== "all") {
      values.push(urgency);
      conditions.push(`LOWER(sr.urgency) = LOWER($${values.length})`);
    }

    if (Number(req.user.role_id) === 3) {
      values.push(req.user.id);
      conditions.push(`sr.requester_user_id = $${values.length}`);
    }

    if (Number(req.user.role_id) === 1 && moderation && moderation !== "all") {
      values.push(moderation);
      conditions.push(`sr.moderation_status = $${values.length}`);
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT 
        sr.*,
        COUNT(q.id) AS quotation_count
      FROM service_requests sr
      LEFT JOIN quotations q ON q.service_request_id = sr.id
      ${whereSql}
      GROUP BY sr.id
      ORDER BY sr.created_at DESC
      `,
      values
    );

    const serializer = Number(req.user.role_id) === 1
      ? serializeServiceRequestForAdmin
      : serializeServiceRequestForClient;
    const data = result.rows.map(serializer);

    res.json({
      success: true,
      data,
    });

  } catch (error) {
    console.error("Get service requests error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch service requests",
      error: error.message,
    });
  }
};

export const getServiceRequestById = async (req, res) => {
  try {
    const { id } = req.params;

    if (Number(req.user.role_id) === 2) {
      const safeResult = await pool.query(
        `
        SELECT
          sr.id,
          sr.service_type,
          sr.service_type_other,
          CASE
            WHEN sr.service_type = 'Other' THEN CONCAT('Other — ', sr.service_type_other)
            ELSE COALESCE(NULLIF(TRIM(sr.service_category), ''), NULLIF(TRIM(sr.service_type), ''))
          END AS inspection_type,
          sr.vessel_type,
          sr.required_by AS inspection_date,
          sr.port_name AS port_of_inspection
        FROM service_requests sr
        WHERE sr.id = $1
          AND sr.moderation_status = 'approved'
        `,
        [id]
      );
      if (!safeResult.rows.length) {
        return res.status(404).json({ success: false, message: "Service request not found" });
      }

      return res.json({
        success: true,
        data: serializeApprovedServiceRequestForConsultant(safeResult.rows[0]),
      });
    }

    const requestResult = await pool.query(
      `
      SELECT 
        sr.*,
        COUNT(q.id) AS quotation_count
      FROM service_requests sr
      LEFT JOIN quotations q ON q.service_request_id = sr.id
      WHERE sr.id = $1
      GROUP BY sr.id
      `,
      [id]
    );

    if (!requestResult.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Service request not found",
      });
    }

    const requestRow = requestResult.rows[0];

    if (!(await canAccessRequest(req.user, requestRow))) {
      return res.status(403).json({
        success: false,
        message: "Access denied for this service request",
      });
    }

    let quotationResult = { rows: [] };

    if (Number(req.user.role_id) === 1) {
      quotationResult = await pool.query(
        `
    SELECT q.*, e.full_name AS expert_name, e.rating AS expert_rating, e.base_location AS expert_location
    FROM quotations q
    LEFT JOIN experts e ON e.id = q.expert_id
    WHERE q.service_request_id = $1
    ORDER BY q.created_at DESC
    `,
        [id]
      );
    }

    if (Number(req.user.role_id) === 2) {
      quotationResult = await pool.query(
        `
    SELECT q.*, e.full_name AS expert_name, e.rating AS expert_rating, e.base_location AS expert_location
    FROM quotations q
    LEFT JOIN experts e ON e.id = q.expert_id
    WHERE q.service_request_id = $1
    AND e.user_id = $2
    ORDER BY q.created_at DESC
    `,
        [id, req.user.id]
      );
    }

    if (Number(req.user.role_id) === 3 && requestRow.accepted_quotation_id) {
      quotationResult = await pool.query(
        `
    SELECT q.*, e.full_name AS expert_name, e.rating AS expert_rating, e.base_location AS expert_location
    FROM quotations q
    LEFT JOIN experts e ON e.id = q.expert_id
    WHERE q.id = $1
    AND q.status = 'accepted'
    `,
        [requestRow.accepted_quotation_id]
      );
    }

    const requestData = mapRequestRow(requestRow);

    if (Number(req.user.role_id) === 2) {
      requestData.requesterName = null;
      requestData.requesterUserId = null;
    }

    const roleId = Number(req.user.role_id);

    if (roleId === 2 && !requestRow.accepted_quotation_id) {
      requestData.requesterName = null;
      requestData.requesterUserId = null;
    }

    requestData.quotations = quotationResult.rows.map((row) => {
      if (Number(req.user.role_id) === 3) {
        return {
          id: row.id,
          expertId: row.expert_id,
          expertName: row.expert_name,
          expertRating: Number(row.expert_rating || 0),
          expertLocation: row.expert_location,
          finalTotalUsd: Number(row.client_total_usd || row.total_quote_usd || 0),
          totalQuoteUsd: Number(row.client_total_usd || row.total_quote_usd || 0),
          status: row.status,
          createdAt: row.created_at,
        };
      }

      return {
        id: row.id,
        expertId: row.expert_id,
        expertName: row.expert_name,
        expertRating: Number(row.expert_rating || 0),
        expertLocation: row.expert_location,
        totalQuoteUsd: Number(row.total_quote_usd || 0),
        adminMarkupUsd: Number(row.admin_markup_usd || 0),
        clientTotalUsd: Number(row.client_total_usd || 0),
        attendanceDays: row.attendance_days,
        travelCost: Number(row.travel_cost || 0),
        accommodationCost: Number(row.accommodation_cost || 0),
        reportFee: Number(row.report_fee || 0),
        urgencySurcharge: Number(row.urgency_surcharge || 0),
        coverLetter: row.cover_letter,
        status: row.status,
        createdAt: row.created_at,
      };
    });

    res.json({
      success: true,
      data: requestData,
    });
  } catch (error) {
    console.error("Get service request by id error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch service request",
      error: error.message,
    });
  }
};

export const updateServiceRequest = async (req, res) => {
  const client = await pool.connect();

  try {
    const id = Number(req.params.id);
    const roleId = Number(req.user.role_id);
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT * FROM service_requests WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!existing.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Service request not found" });
    }
    const request = existing.rows[0];
    if (roleId !== 1 && Number(request.requester_user_id) !== Number(req.user.id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ success: false, message: "Only the request owner or admin can update this request" });
    }
    if (roleId === 1 && request.moderation_status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, code: "REQUEST_ALREADY_MODERATED", message: "Only pending requests may be edited" });
    }

    const fieldMap = {
      title: "title",
      scopeOfWork: "scope_of_work",
      urgency: "urgency",
      budgetUsd: "budget_usd",
      requiredBy: "required_by",
      vesselName: "vessel_name",
      imoNumber: "imo_number",
      vesselType: "vessel_type",
      flagState: "flag_state",
      portId: "port_id",
      portName: "port_name",
      country: "country",
      eta: "eta",
      locationSummary: "location_summary",
      requiredCertification: "required_certification",
    };
    const clientAllowed = new Set([
      "serviceType", "serviceCategory", "title", "scopeOfWork", "urgency",
      "serviceTypeOther",
      "budgetUsd", "requiredBy", "vesselName", "imoNumber", "vesselType",
      "flagState", "portName", "country", "eta", "locationSummary",
      "requiredCertification",
    ]);
    const updates = [];
    const values = [];
    const serviceFields = ["serviceType", "serviceCategory", "serviceTypeOther"];
    if (serviceFields.some((field) => field in req.body)) {
      const serviceSelection = validateServiceSelection({
        serviceType: "serviceType" in req.body ? req.body.serviceType : request.service_type,
        serviceCategory: "serviceCategory" in req.body ? req.body.serviceCategory : request.service_category,
        serviceTypeOther: "serviceTypeOther" in req.body ? req.body.serviceTypeOther : request.service_type_other,
      });
      if (Object.keys(serviceSelection.fieldErrors).length) {
        await client.query("ROLLBACK");
        return sendValidationError(res, serviceSelection.fieldErrors);
      }
      for (const [column, value] of [
        ["service_type", serviceSelection.serviceType],
        ["service_category", serviceSelection.serviceCategory],
        ["service_type_other", serviceSelection.serviceTypeOther],
      ]) {
        values.push(value);
        updates.push(`${column} = $${values.length}`);
      }
    }
    for (const [bodyField, column] of Object.entries(fieldMap)) {
      if (!(bodyField in req.body) || (roleId === 3 && !clientAllowed.has(bodyField))) continue;
      values.push(req.body[bodyField] === "" ? null : req.body[bodyField]);
      updates.push(`${column} = $${values.length}`);
    }
    if (!updates.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "No editable request fields supplied" });
    }
    values.push(id);
    const result = await client.query(
      `UPDATE service_requests SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (roleId === 1) {
      await writeAdminAudit(client, {
        actorUserId: req.user.id,
        action: "service_request.edited",
        targetType: "service_request",
        targetId: id,
        summary: `Updated fields: ${updates.map((item) => item.split(" = ")[0]).join(", ")}`,
      });
    }
    await client.query("COMMIT");
    return res.json({ success: true, message: "Service request updated successfully", data: mapRequestRow(result.rows[0]) });
  } catch (error) {
    await client.query("ROLLBACK");

    res.status(500).json({
      success: false,
      message: "Failed to update service request",
    });
  } finally {
    client.release();
  }
};

export const approveServiceRequest = async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "Invalid service request ID" });
    }
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT * FROM service_requests WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!locked.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Service request not found" });
    }
    const request = locked.rows[0];
    if (request.moderation_status === "approved") {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, code: "REQUEST_ALREADY_APPROVED", message: "Service request is already approved" });
    }
    const inspectionType = serviceSummary(request);
    const vesselType = String(request.vessel_type || "").trim();
    const port = String(request.port_name || "").trim();
    if (!inspectionType || !vesselType || !request.required_by || !port) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        code: "REQUEST_APPROVAL_FIELDS_REQUIRED",
        message: "Inspection type, ship type, inspection date and port are required before approval",
      });
    }
    const approved = await client.query(
      `
      UPDATE service_requests
      SET moderation_status = 'approved', approved_at = CURRENT_TIMESTAMP,
          approved_by_user_id = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
      `,
      [req.user.id, id]
    );
    await createServiceRequestApprovedNotifications(client, {
      requestId: id,
      inspectionType,
      vesselType,
      inspectionDate: request.required_by,
      portOfInspection: port,
    });
    await writeAdminAudit(client, {
      actorUserId: req.user.id,
      action: "service_request.approved",
      targetType: "service_request",
      targetId: id,
      summary: "Approved a pending service request and notified eligible Consultants",
    });
    await client.query("COMMIT");
    return res.json({ success: true, message: "Service request approved", data: mapRequestRow(approved.rows[0]) });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({ success: false, message: "Failed to approve service request", error: error.message });
  } finally {
    client.release();
  }
};

export const deleteServiceRequest = async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "Invalid service request ID" });
    }

    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT id, requester_user_id FROM service_requests WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (!existing.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Service request not found",
      });
    }

    if (
      Number(req.user.role_id) !== 1 &&
      Number(existing.rows[0].requester_user_id) !== Number(req.user.id)
    ) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Only the request owner or admin can delete this request",
      });
    }

    await deleteServiceRequestById(client, id);
    if (Number(req.user.role_id) === 1) {
      await writeAdminAudit(client, {
        actorUserId: req.user.id,
        action: "service_request.deleted",
        targetType: "service_request",
        targetId: id,
        summary: "Deleted an individual service request",
      });
    }
    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Service request deleted successfully",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23503" || error.status === 409) {
      return res.status(409).json({
        success: false,
        message: error.status
          ? error.message
          : "This service request cannot be deleted because related records still depend on it.",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Failed to delete service request",
      error: error.message,
    });
  } finally {
    client.release();
  }
};

export const assignExpertsToRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { expertIds = [] } = req.body;

    if (!Array.isArray(expertIds) || expertIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "expertIds array is required",
      });
    }

    const requestCheck = await pool.query(
      `SELECT id FROM service_requests WHERE id = $1`,
      [id]
    );

    if (!requestCheck.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Service request not found",
      });
    }

    for (const expertId of expertIds) {
      await pool.query(
        `
        INSERT INTO request_expert_assignments (
          service_request_id,
          expert_id,
          assigned_by_user_id
        )
        VALUES ($1, $2, $3)
        ON CONFLICT (service_request_id, expert_id)
        DO UPDATE SET updated_at = CURRENT_TIMESTAMP
        `,
        [id, expertId, req.user.id]
      );
    }

    res.json({
      success: true,
      message: "Experts assigned successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to assign experts",
      error: error.message,
    });
  }
};
