import { pool } from "../config/db.js";
import { requestPortsSql, requestPortCollection, resolveSelectedRequestPorts, persistSelectedRequestPorts, guardPrimaryPortScheduleChange } from "../services/requestPortsService.js";
import { clientQuotationPrice, authorizedClientPriceSql } from "../services/clientQuotationPrice.js";
import { confirmAcceptedExpertAssignment } from "../services/confirmedAssignmentService.js";
import { findOrCreatePort } from "../utils/findOrCreatePort.js";
import { deleteServiceRequestById } from "../services/serviceRequestService.js";
import { createServiceRequestApprovedNotifications } from "../services/adminNotificationService.js";
import { writeAdminAudit } from "../services/adminAuditService.js";
import { getServiceRequestEditPermission } from "../services/serviceRequestEditPermission.js";
import { getActiveProposalForRequest, mapProposalRow } from "../services/commercialProposalService.js";
import { userMayViewRequest } from "../services/requestVisibilityService.js";
import { findInspectionMethod } from "../services/inspectionCatalogueService.js";
import { agentDetailsForRole, consultantHasConfirmedAgentAccess, clientAgentReplacement } from "../services/agentDisclosureService.js";
import { resolveRequestVessel } from "../services/requestVesselService.js";
import { reserveSubmission, completeSubmission } from "../services/requestSubmissionService.js";

import { normalizeRequestParticulars, resolveRequestCompany, resolveRequestPort, REQUEST_PARTICULAR_FIELDS } from "../services/requestParticularsService.js";

const SERVICE_TYPES = new Set(["Audit", "Inspection", "Survey", "Other"]);

const validateServiceSelection = async (queryable, { inspectionMethodId, serviceType, serviceCategory, serviceTypeOther }) => {
  const normalizedType = typeof serviceType === "string" ? serviceType.trim() : "";
  const normalizedCategory = typeof serviceCategory === "string" ? serviceCategory.trim() : "";
  const normalizedOther = typeof serviceTypeOther === "string" ? serviceTypeOther.trim() : "";
  const fieldErrors = {};

  if (inspectionMethodId !== undefined && inspectionMethodId !== null && inspectionMethodId !== "") {
    const method = await findInspectionMethod(queryable, inspectionMethodId);
    if (!method) {
      fieldErrors.inspectionMethodId = "Select a valid service.";
      return { fieldErrors };
    }
    return {
      fieldErrors,
      inspectionMethodId: Number(method.id),
      inspectionVertical: method.vertical_name,
      serviceType: method.name,
      serviceCategory: method.vertical_name,
      serviceTypeOther: null,
    };
  }

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
    inspectionMethodId: null,
    inspectionVertical: normalizedType === "Other" ? "Other" : normalizedCategory,
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
  if (request.inspection_method_id && request.service_type) {
    return String(request.service_type).trim();
  }
  if (request.service_type !== "Other") {
    return String(request.service_category || request.service_type || "").trim();
  }
  const details = String(request.service_type_other || "").trim();
  return details ? `Other: ${details.slice(0, 120)}` : "Other";
};

const calculateApprovedBudget = (clientBudget, adjustmentType, adjustmentMode, adjustmentValue) => {
  if (clientBudget == null || adjustmentType === 'none' || adjustmentMode === 'none') {
    return clientBudget;
  }
  const base = Number(clientBudget);
  const value = Number(adjustmentValue || 0);
  if (!Number.isFinite(base) || !Number.isFinite(value)) return clientBudget;
  
  let delta = 0;
  if (adjustmentType === 'percentage') {
    delta = base * (value / 100);
  } else if (adjustmentType === 'fixed') {
    delta = value;
  }
  
  const approved = adjustmentMode === 'markup' ? base + delta : base - delta;
  return Math.max(0, Math.round(approved * 100) / 100);
};

const mapRequestRow = (row) => ({
  id: row.id,
  inspectionMethodId: row.inspection_method_id == null ? null : Number(row.inspection_method_id),
  inspectionVertical: row.inspection_vertical || row.service_category || null,
  inspectionType: row.inspection_type || (row.service_type === "Other" ? row.service_type_other : row.service_type || row.service_category),
  serviceType: row.service_type,
  serviceCategory: row.service_category,
  serviceTypeOther: row.service_type_other ?? null,
  title: row.title,
  scopeOfWork: row.scope_of_work,
  urgency: row.urgency,
  budgetUsd: row.budget_usd != null ? Number(row.budget_usd) : null,
  clientBudgetUsd: row.client_budget_usd != null ? Number(row.client_budget_usd) : null,
  approvedBudgetUsd: row.approved_budget_usd != null ? Number(row.approved_budget_usd) : null,
  adminBudgetAdjustmentType: row.admin_budget_adjustment_type || 'none',
  adminBudgetAdjustmentMode: row.admin_budget_adjustment_mode || 'none',
  adminBudgetAdjustmentValue: Number(row.admin_budget_adjustment_value || 0),
  requiredBy: row.required_by,
  requesterName: row.requester_name,
  companyName: row.linked_company_name || null,
  companyVerified: Boolean(row.linked_company_name),
  terminalName: row.terminal_name || null,
  ports: requestPortCollection(row),
  agentDetails: agentDetailsForRole(row, 1),
  requesterUserId: row.requester_user_id,
  status: row.status,
  moderationStatus: row.moderation_status,
  rejectionReason: row.rejection_reason || null,
  approvedAt: row.approved_at,
  approvedByUserId: row.approved_by_user_id,
  quotationCount: Number(row.quotation_count || 0),
  acceptedQuotationId: row.accepted_quotation_id,
  acceptedExpertId: row.accepted_expert_id,
  activeProposalId: row.active_proposal_id != null ? Number(row.active_proposal_id) : null,
  workflowStage: row.workflow_stage || null,
  hasAssignment: Boolean(row.has_assignment),

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
  inspectionMethodId: row.inspection_method_id == null ? null : Number(row.inspection_method_id),
  inspectionVertical: row.inspection_vertical || null,
  serviceType: row.service_type,
  serviceTypeOther: row.service_type_other ?? null,
  inspectionType: row.inspection_type,
  vesselType: row.vessel_type,
  inspectionDate: row.inspection_date,
  portOfInspection: row.port_of_inspection,
  terminalName: row.terminal_name || null,
  ports: requestPortCollection(row),
});

const serializeServiceRequestForAdmin = mapRequestRow;
const serializeServiceRequestForClient = (row) => {
  const mapped = mapRequestRow(row);
  const fields = ["id", "inspectionMethodId", "inspectionVertical", "inspectionType", "serviceType", "serviceCategory", "serviceTypeOther",
    "title", "scopeOfWork", "urgency", "budgetUsd", "clientBudgetUsd", "approvedBudgetUsd", "requiredBy", "requesterName",
    "companyName", "companyVerified", "terminalName", "ports", "requesterUserId", "status", "moderationStatus",
    "rejectionReason", "approvedAt", "quotationCount", "acceptedQuotationId", "acceptedExpertId", "activeProposalId", "workflowStage",
    "hasAssignment", "vessel", "port", "requiredCertification", "createdAt", "updatedAt"];
  return Object.fromEntries(fields.map((field) => [field, mapped[field]]));
};

const canAccessRequest = (user, request) => userMayViewRequest(pool, request, user);

export const createServiceRequest = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      inspectionMethodId,
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

    const serviceSelection = await validateServiceSelection(client, { inspectionMethodId, serviceType, serviceCategory, serviceTypeOther });
    const particulars = normalizeRequestParticulars(req.body);
    const fieldErrors = { ...serviceSelection.fieldErrors, ...particulars.fieldErrors };
    if (!String(title || "").trim()) fieldErrors.title = "Request title is required.";
    if (!String(scopeOfWork || "").trim()) fieldErrors.scopeOfWork = "Scope of work is required.";
    if (Object.keys(fieldErrors).length) {
      return sendValidationError(res, fieldErrors);
    }

    await client.query("BEGIN");
    const reservation = await reserveSubmission(client, req.user.id, req.body);
    if (reservation?.replay) {
      await client.query("COMMIT");
      return res.status(200).json(reservation.replay);
    }

    const companyName = await resolveRequestCompany(client, req.user.id);
    const resolvedVessel = Number(req.user.role_id) === 3
      ? await resolveRequestVessel(client, req.body, req.user.id) : null;
    let portId = null;
    let resolvedPortName = portName || null;
    let resolvedCountry = country || null;
    let selectedPorts = null;
    if (Object.hasOwn(req.body, "manualPorts")) {
      if (!Array.isArray(req.body.manualPorts) || req.body.manualPorts.length > 50)
        throw Object.assign(new Error("Select up to 50 new ports."), { status: 400 });
      const selected = await resolveSelectedRequestPorts(client, { portIds: req.body.portIds || [], primaryPortId: req.body.portIds?.[0] });
      const entries = selected.ports.map((p) => ({ ...p, key: `port:${p.id}`, isPrimary: false }));
      const keys = new Set(entries.map((p) => p.key));
      for (const manual of req.body.manualPorts) {
        if (!manual || typeof manual.key !== "string" || !/^manual:[a-zA-Z0-9-]{1,80}$/.test(manual.key) || keys.has(manual.key))
          throw Object.assign(new Error("Invalid new port selection."), { status: 400 });
        keys.add(manual.key);
        const port = await findOrCreatePort({ port_name: manual.portName, country: manual.country, queryable: client });
        entries.push({ ...port, key: manual.key, isPrimary: false });
      }
      if (entries.length > 50) throw Object.assign(new Error("Select up to 50 ports."), { status: 400 });
      const primaryKey = req.body.primaryPortKey;
      if (entries.length && (!primaryKey || !keys.has(primaryKey)))
        throw Object.assign(new Error("Select a valid primary port."), { status: 400 });
      if (!entries.length && primaryKey) throw Object.assign(new Error("An empty selection cannot have a primary port."), { status: 400 });
      if (req.body.portId != null && req.body.portId !== "" && `port:${Number(req.body.portId)}` !== primaryKey)
        throw Object.assign(new Error("Conflicting primary port identifiers."), { status: 400 });
      const unique = [...new Map(entries.map((p) => [Number(p.id), p])).values()];
      if (unique.length !== entries.length) throw Object.assign(new Error("The same port was selected more than once."), { status: 400 });
      selectedPorts = entries.map((p) => ({ ...p, isPrimary: p.key === primaryKey }));
      const primary = selectedPorts.find((p) => p.isPrimary);
      portId = primary?.id || null;
      resolvedPortName = primary?.port_name || null;
      resolvedCountry = primary?.country || null;
    } else if (Object.hasOwn(req.body, "portIds") && Array.isArray(req.body.portIds) && !req.body.portIds.length && portName && country) {
      const port = await findOrCreatePort({ port_name: portName, country, queryable: client });
      portId = port.id; resolvedPortName = port.port_name; resolvedCountry = port.country;
    } else if (Object.hasOwn(req.body, "portIds")) {
      const selected = await resolveSelectedRequestPorts(client, req.body);
      selectedPorts = selected.ports;
      portId = selected.primary?.id || null;
      resolvedPortName = selected.primary?.port_name || null;
      resolvedCountry = selected.primary?.country || null;
    } else if (req.body.portId != null && req.body.portId !== "") {
      const port = await resolveRequestPort(client, req.body.portId);
      portId = port.id;
      resolvedPortName = port.port_name;
      resolvedCountry = port.country;
    }

    if (!Object.hasOwn(req.body, "manualPorts") && !Object.hasOwn(req.body, "portIds") && !portId && portName && country) {
      const port = await findOrCreatePort({
        port_name: portName,
        country,
        region: locationSummary || null,
        queryable: client,
      });

      portId = port.id;
      resolvedPortName = port.port_name;
      resolvedCountry = port.country;
    }

    const result = await client.query(
      `
      INSERT INTO service_requests (
        service_type,
        service_category,
        service_type_other,
        inspection_method_id,
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
        status,
        client_budget_usd,
        approved_budget_usd, terminal_name, agent_company_name, agent_contact_name, agent_email, agent_phone, vessel_id
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31
      )
      RETURNING *
      `,
      [
        serviceSelection.serviceType,
        serviceSelection.serviceCategory,
        serviceSelection.serviceTypeOther,
        serviceSelection.inspectionMethodId,
        String(title).trim(),
        String(scopeOfWork).trim(),
        urgency || "routine",
        budgetUsd || null,
        requiredBy || null,
        Number(req.user.role_id) === 3 ? companyName : (companyName || String(requesterName || "").trim() || null),
        resolvedVessel?.name || vesselName || null,
        resolvedVessel?.imo || imoNumber || null,
        (typeof vesselType === "string" && vesselType.trim() ? vesselType.trim() : resolvedVessel?.type || null),
        (typeof flagState === "string" && flagState.trim() ? flagState.trim() : resolvedVessel?.flag || null),
        portId,
        resolvedPortName,
        resolvedCountry,
        eta || null,
        locationSummary || null,
        requiredCertification || null,
        req.user.id,
        "pending",
        "open",
        budgetUsd || null,
        budgetUsd || null,
        ...Object.keys(REQUEST_PARTICULAR_FIELDS).map((key) => particulars.values[key] ?? null),
        resolvedVessel?.id || null,
      ]
    );

    if (selectedPorts !== null || portId) await persistSelectedRequestPorts(client, result.rows[0].id,
      selectedPorts || [{ id: portId, isPrimary: true }]);
    const response = {
      success: true,
      message: "Service request created successfully",
      data: (Number(req.user.role_id) === 3 ? serializeServiceRequestForClient : mapRequestRow)({ ...result.rows[0], selected_ports: selectedPorts, linked_company_name: companyName }),
    };
    await completeSubmission(client, req.user.id, reservation, result.rows[0].id, response);
    await client.query("COMMIT");
    res.status(201).json(response);
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.fieldErrors) return sendValidationError(res, error.fieldErrors);
    if (error.status === 403) return res.status(403).json({ success: false, message: error.message });
    if (error.status === 409) return res.status(409).json({ success: false, message: error.message });
    if (error.status === 400) return sendValidationError(res, { portId: error.message });
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
        `(LOWER(sr.status) IN ('open', 'pending', 'active') OR (LOWER(sr.status) IN ('assigned', 'completed') AND EXISTS (
          SELECT 1 FROM experts own_expert WHERE own_expert.user_id=$1 AND
          (own_expert.id=sr.accepted_expert_id OR EXISTS (
            SELECT 1 FROM request_expert_assignments own_assignment
            WHERE own_assignment.service_request_id=sr.id AND own_assignment.expert_id=own_expert.id)))))`,
      ];
      const values = [req.user.id];

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
          sr.inspection_method_id,
          sr.service_category AS inspection_vertical,
          sr.service_type,
          sr.service_type_other,
          CASE
            WHEN sr.service_type = 'Other' THEN CONCAT('Other — ', sr.service_type_other)
            ELSE COALESCE(NULLIF(TRIM(sr.service_type), ''), NULLIF(TRIM(sr.service_category), ''))
          END AS inspection_type,
          sr.vessel_type,
          sr.required_by AS inspection_date,
          sr.terminal_name,
          sr.port_name AS port_of_inspection, sr.port_id, sr.country, ${requestPortsSql("sr")} AS selected_ports
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
        sr.*, ${requestPortsSql("sr")} AS selected_ports,
        (SELECT cc.legal_name FROM client_profiles cp JOIN client_companies cc ON cc.client_profile_id=cp.id WHERE cp.user_id=sr.requester_user_id LIMIT 1) AS linked_company_name,
        COUNT(q.id) AS quotation_count,
        EXISTS(SELECT 1 FROM request_expert_assignments rea WHERE rea.service_request_id=sr.id) AS has_assignment,
        (SELECT iw.current_stage FROM inspection_workflows iw WHERE iw.service_request_id=sr.id LIMIT 1) AS workflow_stage
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
          sr.inspection_method_id,
          sr.service_category AS inspection_vertical,
          sr.service_type,
          sr.service_type_other,
          CASE
            WHEN sr.service_type = 'Other' THEN CONCAT('Other — ', sr.service_type_other)
            ELSE COALESCE(NULLIF(TRIM(sr.service_type), ''), NULLIF(TRIM(sr.service_category), ''))
          END AS inspection_type,
          sr.vessel_type,
          sr.required_by AS inspection_date,
          sr.terminal_name,
          sr.port_name AS port_of_inspection, sr.port_id, sr.country, sr.status, sr.moderation_status,
          sr.accepted_expert_id, sr.agent_contact_name, ${requestPortsSql("sr")} AS selected_ports
        FROM service_requests sr
        WHERE sr.id = $1
          AND sr.moderation_status = 'approved'
        `,
        [id]
      );
      if (!safeResult.rows.length) {
        return res.status(404).json({ success: false, message: "Service request not found" });
      }

      if (!(await canAccessRequest(req.user, safeResult.rows[0]))) {
        return res.status(403).json({ success: false, message: "Access denied for this service request" });
      }

      const assigned = await consultantHasConfirmedAgentAccess(pool, safeResult.rows[0].id, req.user.id);
      return res.json({
        success: true,
        data: { ...serializeApprovedServiceRequestForConsultant(safeResult.rows[0]),
          ...(assigned ? { agentDetails: agentDetailsForRole(safeResult.rows[0], 2, true) } : {}) },
      });
    }

    const requestResult = await pool.query(
      `
      SELECT 
        sr.*, ${requestPortsSql("sr")} AS selected_ports,
        (SELECT cc.legal_name FROM client_profiles cp JOIN client_companies cc ON cc.client_profile_id=cp.id WHERE cp.user_id=sr.requester_user_id LIMIT 1) AS linked_company_name,
        COUNT(q.id) AS quotation_count,
        EXISTS(SELECT 1 FROM request_expert_assignments rea WHERE rea.service_request_id=sr.id) AS has_assignment,
        (SELECT iw.current_stage FROM inspection_workflows iw WHERE iw.service_request_id=sr.id LIMIT 1) AS workflow_stage
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
    SELECT q.*, ${authorizedClientPriceSql("q")} AS authorized_client_total_usd, e.full_name AS expert_name, e.rating AS expert_rating, e.base_location AS expert_location
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
    SELECT q.*, ${authorizedClientPriceSql("q")} AS authorized_client_total_usd, e.full_name AS expert_name, e.rating AS expert_rating, e.base_location AS expert_location
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
    SELECT q.*, ${authorizedClientPriceSql("q")} AS authorized_client_total_usd, e.full_name AS expert_name, e.rating AS expert_rating, e.base_location AS expert_location
    FROM quotations q
    LEFT JOIN experts e ON e.id = q.expert_id
    WHERE q.id = $1
    AND q.status = 'accepted'
    `,
        [requestRow.accepted_quotation_id]
      );
    }

    const requestData = Number(req.user.role_id) === 3 ? serializeServiceRequestForClient(requestRow) : mapRequestRow(requestRow);

    if (Number(req.user.role_id) === 1) {
      const submitter = requestRow.requester_user_id
        ? (await pool.query("SELECT id, full_name, email FROM users WHERE id=$1", [requestRow.requester_user_id])).rows[0]
        : null;
      requestData.submittedBy = submitter
        ? { id: submitter.id, fullName: submitter.full_name, email: submitter.email, source: "account" }
        : { source: "legacy" };
    }

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
          finalTotalUsd: clientQuotationPrice(row),
          totalQuoteUsd: clientQuotationPrice(row),
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

    const activeProposalRow = await getActiveProposalForRequest(id, pool, roleId === 3);
    requestData.proposal = activeProposalRow && (roleId === 1 || ["sent", "approved", "rejected"].includes(activeProposalRow.status))
      ? mapProposalRow(activeProposalRow, req.user) : null;

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
      `SELECT sr.*, ${requestPortsSql("sr")} AS selected_ports,
        (SELECT cc.legal_name FROM client_profiles cp JOIN client_companies cc ON cc.client_profile_id=cp.id WHERE cp.user_id=sr.requester_user_id LIMIT 1) AS linked_company_name,
              (SELECT COUNT(*)::int FROM quotations q WHERE q.service_request_id=sr.id) AS quotation_count,
              EXISTS(SELECT 1 FROM commercial_proposals offer WHERE offer.service_request_id=sr.id AND offer.status='sent') AS has_sent_proposal,
              EXISTS(SELECT 1 FROM quotations q WHERE q.service_request_id=sr.id AND LOWER(q.status)='accepted') AS has_accepted_quotation,
              EXISTS(SELECT 1 FROM request_expert_assignments rea WHERE rea.service_request_id=sr.id) AS has_assignment,
              (SELECT iw.current_stage FROM inspection_workflows iw WHERE iw.service_request_id=sr.id LIMIT 1) AS workflow_stage
         FROM service_requests sr WHERE sr.id = $1 FOR UPDATE OF sr`,
      [id]
    );
    if (!existing.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Service request not found" });
    }
    const request = existing.rows[0];
    const permission = getServiceRequestEditPermission({ request, roleId, userId: req.user.id });
    if (!permission.allowed) {
      await client.query("ROLLBACK");
      return res.status(permission.status).json({ success: false, code: permission.code, message: permission.message });
    }

    const particulars = normalizeRequestParticulars(roleId === 3 ? clientAgentReplacement(req.body) : req.body);
    if (Object.keys(particulars.fieldErrors).length) {
      await client.query("ROLLBACK");
      return sendValidationError(res, particulars.fieldErrors);
    }
    const normalizedBody = { ...(roleId === 3 ? clientAgentReplacement(req.body) : req.body), ...particulars.values };
    if (roleId === 3) delete normalizedBody.vesselId;
    if (roleId === 3 && ["vesselName", "imoNumber", "vesselType", "flagState", "selectedVessel"].some((key) => Object.hasOwn(req.body, key))) {
      const changed = [
        ["vesselName", "vessel_name"], ["imoNumber", "imo_number"],
        ["vesselType", "vessel_type"], ["flagState", "flag_state"],
      ].some(([key, column]) => Object.hasOwn(req.body, key) && String(req.body[key] ?? "") !== String(request[column] ?? ""));
      if (changed || req.body.selectedVessel || !request.vessel_id) {
        const resolved = await resolveRequestVessel(client, { ...req.body,
          vesselName: req.body.vesselName ?? request.vessel_name,
          imoNumber: req.body.imoNumber ?? request.imo_number,
          vesselType: req.body.vesselType ?? request.vessel_type,
          flagState: req.body.flagState ?? request.flag_state,
        }, req.user.id);
        if (resolved) {
          normalizedBody.vesselId = resolved.id;
          if (changed || req.body.selectedVessel) Object.assign(normalizedBody, {
            vesselName: resolved.name, imoNumber: resolved.imo,
            vesselType: resolved.type, flagState: resolved.flag,
          });
        }
      }
    }
    let selectedPorts = null;
    if (Object.hasOwn(req.body, "portIds")) {
      const selected = await resolveSelectedRequestPorts(client, req.body, requestPortCollection(request).map((p) => Number(p.id)));
      selectedPorts = selected.ports;
      guardPrimaryPortScheduleChange(request, selected.primary?.id, req.body);
      Object.assign(normalizedBody, { portId: selected.primary?.id || null, portName: selected.primary?.port_name || null, country: selected.primary?.country || null });
      if (Number(request.port_id || 0) !== Number(normalizedBody.portId || 0)) {
        normalizedBody.terminalName = Object.hasOwn(req.body, "terminalName") ? normalizedBody.terminalName : null;
        normalizedBody.eta = Object.hasOwn(req.body, "eta") ? normalizedBody.eta : null;
      }
    } else if (Object.hasOwn(req.body, "portId") && req.body.portId != null && req.body.portId !== "") {
      const port = await resolveRequestPort(client, req.body.portId);
      Object.assign(normalizedBody, { portId: port.id, portName: port.port_name, country: port.country });
      if (Number(request.port_id || 0) !== Number(port.id)) {
        guardPrimaryPortScheduleChange(request, port.id, req.body);
        selectedPorts = [{ ...port, isPrimary: true }];
        normalizedBody.terminalName = req.body.terminalName ?? null;
        normalizedBody.eta = req.body.eta ?? null;
      }
    } else if ((Object.hasOwn(req.body, "portId") && req.body.portId == null) ||
        (Object.hasOwn(req.body, "portName") && req.body.portName !== request.port_name)) {
      guardPrimaryPortScheduleChange(request, null, req.body);
      selectedPorts = [];
      normalizedBody.portId = null;
      if (request.port_id) { normalizedBody.terminalName = req.body.terminalName ?? null; normalizedBody.eta = req.body.eta ?? null; }
    }
    const fieldMap = {
      ...Object.fromEntries(Object.entries(REQUEST_PARTICULAR_FIELDS).map(([key, [column]]) => [key, column])),
      title: "title",
      scopeOfWork: "scope_of_work",
      urgency: "urgency",
      requiredBy: "required_by",
      vesselName: "vessel_name",
      imoNumber: "imo_number",
      vesselType: "vessel_type",
      flagState: "flag_state",
      vesselId: "vessel_id",
      portId: "port_id",
      portName: "port_name",
      country: "country",
      eta: "eta",
      locationSummary: "location_summary",
      requiredCertification: "required_certification",
    };
    const clientAllowed = new Set([
      ...Object.keys(REQUEST_PARTICULAR_FIELDS), "portId",
      "inspectionMethodId",
      "serviceType", "serviceCategory", "title", "scopeOfWork", "urgency",
      "serviceTypeOther",
      "budgetUsd", "requiredBy", "vesselName", "imoNumber", "vesselType",
      "flagState", "vesselId", "portName", "country", "eta", "locationSummary",
      "requiredCertification",
    ]);
    const updates = [];
    const values = [];
    const serviceFields = ["inspectionMethodId", "serviceType", "serviceCategory", "serviceTypeOther"];
    if (serviceFields.some((field) => field in req.body)) {
      const serviceSelection = await validateServiceSelection(client, {
        inspectionMethodId: "inspectionMethodId" in req.body ? req.body.inspectionMethodId : request.inspection_method_id,
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
        ["inspection_method_id", serviceSelection.inspectionMethodId],
      ]) {
        values.push(value);
        updates.push(`${column} = $${values.length}`);
      }
    }
    for (const [bodyField, column] of Object.entries(fieldMap)) {
      if (!(bodyField in normalizedBody) || (roleId === 3 && !clientAllowed.has(bodyField))) continue;
      values.push(normalizedBody[bodyField] === "" ? null : normalizedBody[bodyField]);
      updates.push(`${column} = $${values.length}`);
    }

    if (!("portId" in normalizedBody) && "portName" in req.body && req.body.portName !== request.port_name) updates.push("port_id = NULL");

    let editedClientBudget;
    if ("budgetUsd" in req.body) {
      editedClientBudget = req.body.budgetUsd === "" || req.body.budgetUsd === null
        ? null
        : Number(req.body.budgetUsd);
      if (editedClientBudget !== null && (!Number.isFinite(editedClientBudget) || editedClientBudget < 0)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Budget must be a non-negative number" });
      }
      values.push(editedClientBudget);
      updates.push(`budget_usd = $${values.length}`);
      values.push(editedClientBudget);
      updates.push(`client_budget_usd = $${values.length}`);
    }

    // Admin-only budget adjustment fields
    if (roleId === 1) {
      const adjType = req.body.adminBudgetAdjustmentType;
      const adjMode = req.body.adminBudgetAdjustmentMode;
      const adjValue = req.body.adminBudgetAdjustmentValue;
      const explicitApprovedBudget = req.body.approvedBudgetUsd;

      if (adjType !== undefined) {
        if (!['none', 'percentage', 'fixed'].includes(adjType)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ success: false, message: "Invalid budget adjustment type" });
        }
        values.push(adjType);
        updates.push(`admin_budget_adjustment_type = $${values.length}`);
      }
      if (adjMode !== undefined) {
        if (!['none', 'markup', 'markdown'].includes(adjMode)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ success: false, message: "Invalid budget adjustment mode" });
        }
        values.push(adjMode);
        updates.push(`admin_budget_adjustment_mode = $${values.length}`);
      }
      if (adjValue !== undefined) {
        const numVal = Number(adjValue);
        if (!Number.isFinite(numVal) || numVal < 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ success: false, message: "Budget adjustment value must be a non-negative number" });
        }
        values.push(numVal);
        updates.push(`admin_budget_adjustment_value = $${values.length}`);
      }

      // Calculate approved budget if adjustment params provided
      const finalAdjType = adjType || request.admin_budget_adjustment_type || 'none';
      const finalAdjMode = adjMode || request.admin_budget_adjustment_mode || 'none';
      const finalAdjValue = adjValue !== undefined ? Number(adjValue) : Number(request.admin_budget_adjustment_value || 0);
      // Use updated client budget if provided in this request, otherwise existing
      const clientBudget = req.body.budgetUsd !== undefined
        ? editedClientBudget
        : (request.client_budget_usd != null ? Number(request.client_budget_usd) : null);

      if (explicitApprovedBudget !== undefined) {
        // Admin explicitly sets approved budget (e.g. when no client budget exists)
        const numApproved = Number(explicitApprovedBudget);
        if (explicitApprovedBudget !== null && explicitApprovedBudget !== '' && (!Number.isFinite(numApproved) || numApproved < 0)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ success: false, message: "Approved budget must be a non-negative number" });
        }
        values.push(explicitApprovedBudget === '' || explicitApprovedBudget === null ? null : numApproved);
        updates.push(`approved_budget_usd = $${values.length}`);
      } else if (req.body.budgetUsd !== undefined || adjType !== undefined || adjMode !== undefined || adjValue !== undefined) {
        const approvedBudget = calculateApprovedBudget(clientBudget, finalAdjType, finalAdjMode, finalAdjValue);
        values.push(approvedBudget);
        updates.push(`approved_budget_usd = $${values.length}`);
      }
    }

    const suppliedEditableFields = updates.length > 0;
    if (!suppliedEditableFields) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "No editable request fields supplied" });
    }

    // Every Client edit remains behind moderation and invalidates any prior Admin budget decision.
    if (roleId === 3) {
      values.push("pending");
      updates.push(`moderation_status = $${values.length}`);
      if (request.moderation_status === "rejected") updates.push(`rejection_reason = NULL`);

      values.push("none");
      updates.push(`admin_budget_adjustment_type = $${values.length}`);
      values.push("none");
      updates.push(`admin_budget_adjustment_mode = $${values.length}`);
      values.push(0);
      updates.push(`admin_budget_adjustment_value = $${values.length}`);

      const revisedClientBudget = req.body.budgetUsd !== undefined
        ? editedClientBudget
        : (request.client_budget_usd == null ? null : Number(request.client_budget_usd));
      values.push(revisedClientBudget);
      updates.push(`approved_budget_usd = $${values.length}`);
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
    } else if (roleId === 3) {
      await writeAdminAudit(client, {
        actorUserId: req.user.id,
        action: request.moderation_status === "rejected" ? "service_request.resubmitted" : "service_request.client_edited",
        targetType: "service_request",
        targetId: id,
        summary: request.moderation_status === "rejected" ? "Client corrected and resubmitted rejected request" : "Client edited request; Admin review remains required",
      });
    }
    if (selectedPorts !== null) await persistSelectedRequestPorts(client, id, selectedPorts);
    await client.query("COMMIT");
    const message = roleId === 3
      ? (request.moderation_status === "rejected" ? "Request resubmitted for review" : "Request updated and submitted for review")
      : "Service request updated successfully";
    return res.json({ success: true, message, data: (roleId === 3 ? serializeServiceRequestForClient : mapRequestRow)({ ...result.rows[0], selected_ports: selectedPorts ?? request.selected_ports, linked_company_name: request.linked_company_name }) });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.fieldErrors) return sendValidationError(res, error.fieldErrors);
    if (error.status === 403) return res.status(403).json({ success: false, message: error.message });
    if (error.status === 409) return res.status(409).json({ success: false, message: error.message });
    if (error.status === 400) return sendValidationError(res, { portId: error.message });
    console.error("Update service request error:", error);
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
    const title = String(request.title || "").trim();
    const scopeOfWork = String(request.scope_of_work || "").trim();
    const missingFields = [];
    if (!title) missingFields.push("Title");
    if (!scopeOfWork) missingFields.push("Scope of Work");
    if (!inspectionType) missingFields.push("Service Type");
    if (!vesselType) missingFields.push("Vessel Type");
    if (!request.required_by) missingFields.push("Required Inspection Date");
    if (!port) missingFields.push("Port of Inspection");
    if (missingFields.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        code: "REQUEST_APPROVAL_FIELDS_REQUIRED",
        message: "Required request details are missing.",
        missingFields,
      });
    }

    // Finalize approved budget
    const finalApprovedBudget = request.approved_budget_usd != null
      ? request.approved_budget_usd
      : request.client_budget_usd;

    const approved = await client.query(
      `
      UPDATE service_requests
      SET moderation_status = 'approved', approved_at = CURRENT_TIMESTAMP,
          approved_by_user_id = $1, approved_budget_usd = COALESCE(approved_budget_usd, client_budget_usd, budget_usd),
          budget_usd = COALESCE(approved_budget_usd, client_budget_usd, budget_usd),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *, ${requestPortsSql("service_requests")} AS selected_ports
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

export const rejectServiceRequest = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: "Invalid service request ID" });
  }
  const { rejectionReason } = req.body;
  const reason = String(rejectionReason || "").trim();
  if (!reason || reason.length < 1) {
    return res.status(400).json({ success: false, message: "A rejection reason is required." });
  }
  if (reason.length > 1000) {
    return res.status(400).json({ success: false, message: "Rejection reason must be 1000 characters or fewer." });
  }

  const client = await pool.connect();
  try {
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
    if (request.moderation_status === 'approved') {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, code: "REQUEST_ALREADY_APPROVED", message: "Cannot reject an already approved request" });
    }
    if (request.moderation_status === 'rejected') {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, code: "REQUEST_ALREADY_REJECTED", message: "Service request is already rejected" });
    }
    const rejected = await client.query(
      `
      UPDATE service_requests
      SET moderation_status = 'rejected', rejection_reason = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *, ${requestPortsSql("service_requests")} AS selected_ports
      `,
      [reason, id]
    );
    await writeAdminAudit(client, {
      actorUserId: req.user.id,
      action: "service_request.rejected",
      targetType: "service_request",
      targetId: id,
      summary: `Rejected service request: ${reason.slice(0, 200)}`,
      reason,
    });
    await client.query("COMMIT");
    return res.json({ success: true, message: "Service request rejected", data: mapRequestRow(rejected.rows[0]) });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({ success: false, message: "Failed to reject service request", error: error.message });
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
    const data = await confirmAcceptedExpertAssignment({ requestId: req.params.id, expertIds: req.body?.expertIds, actor: req.user });
    res.json({ success: true, message: "Client-approved Expert assignment confirmed", data });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      code: error.code || "ASSIGNMENT_FAILED",
      message: error.status ? error.message : "Failed to confirm Expert assignment",
    });
  }
};
