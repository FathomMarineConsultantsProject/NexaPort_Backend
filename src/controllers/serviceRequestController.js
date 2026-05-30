import { pool } from "../config/db.js";
import { findOrCreatePort } from "../utils/findOrCreatePort.js";

const mapRequestRow = (row) => ({
  id: row.id,
  serviceType: row.service_type,
  serviceCategory: row.service_category,
  title: row.title,
  scopeOfWork: row.scope_of_work,
  urgency: row.urgency,
  budgetUsd: Number(row.budget_usd || 0),
  requiredBy: row.required_by,
  requesterName: row.requester_name,
  requesterUserId: row.requester_user_id,
  status: row.status,
  quotationCount: Number(row.quotation_count || 0),

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

const canAccessRequest = async (user, request) => {
  const roleId = Number(user.role_id);

  if (roleId === 1) return true;

  if (roleId === 3) {
    return Number(request.requester_user_id) === Number(user.id);
  }

  if (roleId === 2) {
    const assigned = await pool.query(
      `
      SELECT rea.id
      FROM request_expert_assignments rea
      JOIN experts e ON e.id = rea.expert_id
      WHERE rea.service_request_id = $1
      AND e.user_id = $2
      `,
      [request.id, user.id]
    );

    return assigned.rows.length > 0;
  }

  return false;
};

export const createServiceRequest = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      serviceType,
      serviceCategory,
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

    if (!serviceType || !serviceCategory || !title || !scopeOfWork) {
      return res.status(400).json({
        success: false,
        message: "serviceType, serviceCategory, title and scopeOfWork are required",
      });
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
        requester_user_id
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        $9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
      )
      RETURNING *
      `,
      [
        serviceType,
        serviceCategory,
        title,
        scopeOfWork,
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
      error: error.message,
    });
  } finally {
    client.release();
  }
};

export const getServiceRequests = async (req, res) => {
  try {
    const { search, type, status, urgency } = req.query;

    const conditions = [];
    const values = [];

    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(
        sr.title ILIKE $${values.length}
        OR sr.port_name ILIKE $${values.length}
        OR sr.vessel_name ILIKE $${values.length}
        OR sr.service_category ILIKE $${values.length}
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

    if (Number(req.user.role_id) === 2) {
      values.push(req.user.id);
      conditions.push(`
    sr.id IN (
      SELECT rea.service_request_id
      FROM request_expert_assignments rea
      JOIN experts e ON e.id = rea.expert_id
      WHERE e.user_id = $${values.length}
    )
  `);
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

    res.json({
      success: true,
      data: result.rows.map(mapRequestRow),
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
    SELECT 
      q.*,
      e.full_name AS expert_name,
      e.rating AS expert_rating,
      e.base_location AS expert_location
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
    SELECT 
      q.*,
      e.full_name AS expert_name,
      e.rating AS expert_rating,
      e.base_location AS expert_location
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
    SELECT 
      q.*,
      e.full_name AS expert_name,
      e.rating AS expert_rating,
      e.base_location AS expert_location
    FROM quotations q
    LEFT JOIN experts e ON e.id = q.expert_id
    WHERE q.id = $1
    `,
        [requestRow.accepted_quotation_id]
      );
    }

    const requestData = mapRequestRow(requestRow);

    const roleId = Number(req.user.role_id);

if (roleId === 2 && !requestRow.accepted_quotation_id) {
  requestData.requesterName = null;
  requestData.requesterUserId = null;
}

    requestData.quotations = quotationResult.rows.map((row) => {
      const isAccepted = row.status === "accepted";
      const isAdmin = Number(req.user.role_id) === 1;
      const isExpert = Number(req.user.role_id) === 2;

      return {
        id: row.id,
        expertId: isAdmin || isAccepted || isExpert ? row.expert_id : null,
        expertName: isAdmin || isAccepted || isExpert ? row.expert_name : null,
        expertRating: isAdmin || isAccepted || isExpert ? Number(row.expert_rating || 0) : null,
        expertLocation: isAdmin || isAccepted || isExpert ? row.expert_location : null,
        totalQuoteUsd: Number(row.total_quote_usd || 0),
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
    const { id } = req.params;

    const existing = await client.query(
      `SELECT * FROM service_requests WHERE id = $1`,
      [id]
    );

    if (!existing.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Service request not found",
      });
    }

    const existingRequest = existing.rows[0];

    if (
      Number(req.user.role_id) !== 1 &&
      Number(existingRequest.requester_user_id) !== Number(req.user.id)
    ) {
      return res.status(403).json({
        success: false,
        message: "Only the request owner or admin can update this request",
      });
    }

    const {
      serviceType,
      serviceCategory,
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
      status,
    } = req.body;

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
      UPDATE service_requests
      SET
        service_type = COALESCE($1, service_type),
        service_category = COALESCE($2, service_category),
        title = COALESCE($3, title),
        scope_of_work = COALESCE($4, scope_of_work),
        urgency = COALESCE($5, urgency),
        budget_usd = COALESCE($6, budget_usd),
        required_by = COALESCE($7, required_by),
        requester_name = COALESCE($8, requester_name),
        vessel_name = COALESCE($9, vessel_name),
        imo_number = COALESCE($10, imo_number),
        vessel_type = COALESCE($11, vessel_type),
        flag_state = COALESCE($12, flag_state),
        port_id = COALESCE($13, port_id),
        port_name = COALESCE($14, port_name),
        country = COALESCE($15, country),
        eta = COALESCE($16, eta),
        location_summary = COALESCE($17, location_summary),
        required_certification = COALESCE($18, required_certification),
        status = COALESCE($19, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $20
      RETURNING *
      `,
      [
        serviceType || null,
        serviceCategory || null,
        title || null,
        scopeOfWork || null,
        urgency || null,
        budgetUsd || null,
        requiredBy || null,
        requesterName || null,
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
        status || null,
        id,
      ]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Service request updated successfully",
      data: mapRequestRow(result.rows[0]),
    });
  } catch (error) {
    await client.query("ROLLBACK");

    res.status(500).json({
      success: false,
      message: "Failed to update service request",
      error: error.message,
    });
  } finally {
    client.release();
  }
};

export const deleteServiceRequest = async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query(
      `SELECT id, requester_user_id FROM service_requests WHERE id = $1`,
      [id]
    );

    if (!existing.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Service request not found",
      });
    }

    if (
      Number(req.user.role_id) !== 1 &&
      Number(existing.rows[0].requester_user_id) !== Number(req.user.id)
    ) {
      return res.status(403).json({
        success: false,
        message: "Only the request owner or admin can delete this request",
      });
    }

    await pool.query(`DELETE FROM service_requests WHERE id = $1`, [id]);

    res.json({
      success: true,
      message: "Service request deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete service request",
      error: error.message,
    });
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