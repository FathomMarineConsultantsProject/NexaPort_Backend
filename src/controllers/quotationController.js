import { clientQuotationPrice, authorizedClientPriceSql } from "../services/clientQuotationPrice.js";
import { pool } from "../config/db.js";
import { calculateQuotationTotals } from "../services/quotationAcceptanceService.js";
import { createQuotationThread, decideQuotationRevision, getNegotiation, submitQuotationRevision } from "../services/quotationNegotiationService.js";
export { calculateQuotationTotals } from "../services/quotationAcceptanceService.js";

const mapQuotationRow = (row, user) => {
  const roleId = Number(user.role_id);

  const base = {
    id: row.id,
    serviceRequestId: row.service_request_id,
    status: row.status,
    attendanceDays: row.attendance_days,
    coverLetter: roleId === 1 || roleId === 2 ? row.cover_letter : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    internalStatus: roleId === 1 || roleId === 2 ? row.internal_review_status : undefined,
    latestRevisionId: roleId === 1 || roleId === 2 ? row.latest_revision_id : undefined,
    approvedRevisionId: roleId === 1 || roleId === 2 ? row.approved_revision_id : undefined,
  };

  if (roleId === 1) {
    return {
      ...base,
      expertId: row.expert_id,
      expertUserId: row.expert_user_id,
      expertName: row.expert_name,
      expertRating: Number(row.expert_rating || 0),
      expertLocation: row.expert_location,
      expertQuoteUsd: Number(row.total_quote_usd || 0),
      adminMarkupUsd: Number(row.admin_markup_usd || 0),
      clientTotalUsd: Number(row.client_total_usd || 0),
      travelCost: Number(row.travel_cost || 0),
      accommodationCost: Number(row.accommodation_cost || 0),
      reportFee: Number(row.report_fee || 0),
      urgencySurcharge: Number(row.urgency_surcharge || 0),
    };
  }

  if (roleId === 2) {
    return {
      ...base,
      expertId: row.expert_id,
      totalQuoteUsd: Number(row.total_quote_usd || 0),
      travelCost: Number(row.travel_cost || 0),
      accommodationCost: Number(row.accommodation_cost || 0),
      reportFee: Number(row.report_fee || 0),
      urgencySurcharge: Number(row.urgency_surcharge || 0),
    };
  }

  if (roleId === 3) {
  const finalAmount = clientQuotationPrice(row);

  return {
    ...base,
    expertId: row.status === "accepted" ? row.expert_id : null,
    expertName: row.status === "accepted" ? row.expert_name : null,
    expertRating: row.status === "accepted" ? Number(row.expert_rating || 0) : null,
    expertLocation: row.status === "accepted" ? row.expert_location : null,

    // client sees only final total, no breakdown
    finalTotalUsd: finalAmount,
    totalQuoteUsd: finalAmount,
  };
}

  return base;
};

const canAccessQuotation = (user, row) => {
  const roleId = Number(user.role_id);

  if (roleId === 1) return true;
  if (roleId === 2) return Number(row.expert_user_id) === Number(user.id);
  if (roleId === 3) return Number(row.requester_user_id) === Number(user.id);

  return false;
};

export const getQuotations = async (req, res) => {
  try {
    const { serviceRequestId, expertId, status } = req.query;

    const conditions = [];
    const values = [];

    if (serviceRequestId) {
      values.push(serviceRequestId);
      conditions.push(`q.service_request_id = $${values.length}`);
    }

    if (expertId) {
      values.push(expertId);
      conditions.push(`q.expert_id = $${values.length}`);
    }

    if (status && status !== "all") {
      values.push(status);
      conditions.push(`LOWER(q.status) = LOWER($${values.length})`);
    }

    if (Number(req.user.role_id) === 2) {
      values.push(req.user.id);
      conditions.push(`q.expert_user_id = $${values.length}`);
    }

    if (Number(req.user.role_id) === 3) {
      values.push(req.user.id);
      conditions.push(`sr.requester_user_id = $${values.length}`);
      conditions.push(`q.status = 'accepted'`);
    }

    const whereSql = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const result = await pool.query(
      `
      SELECT
        q.*, ${authorizedClientPriceSql("q")} AS authorized_client_total_usd,
        sr.requester_user_id,
        e.full_name AS expert_name,
        e.rating AS expert_rating,
        e.base_location AS expert_location
      FROM quotations q
      LEFT JOIN service_requests sr ON sr.id = q.service_request_id
      LEFT JOIN experts e ON e.id = q.expert_id
      ${whereSql}
      ORDER BY q.created_at DESC
      `,
      values
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows.map((row) => mapQuotationRow(row, req.user)),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch quotations",
      error: error.message,
    });
  }
};

export const getQuotationById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        q.*, ${authorizedClientPriceSql("q")} AS authorized_client_total_usd,
        sr.requester_user_id,
        e.full_name AS expert_name,
        e.rating AS expert_rating,
        e.base_location AS expert_location
      FROM quotations q
      LEFT JOIN service_requests sr ON sr.id = q.service_request_id
      LEFT JOIN experts e ON e.id = q.expert_id
      WHERE q.id = $1
      `,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Quotation not found",
      });
    }

    if (!canAccessQuotation(req.user, result.rows[0])) {
      return res.status(403).json({
        success: false,
        message: "Access denied for this quotation",
      });
    }

    if (
      Number(req.user.role_id) === 3 &&
      result.rows[0].status !== "accepted"
    ) {
      return res.status(403).json({
        success: false,
        message: "Client can only view accepted quotation",
      });
    }

    res.json({
      success: true,
      data: mapQuotationRow(result.rows[0], req.user),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch quotation",
      error: error.message,
    });
  }
};

const negotiationError = (res, error) => res.status(error.status || (error.code === "23505" ? 409 : 500)).json({success:false,code:error.code || "NEGOTIATION_ERROR",message:error.status ? error.message : "Unable to process quotation"});
export const createQuotation = async (req,res) => {
  try { const row=await createQuotationThread({actor:req.user,body:req.body}); return res.status(201).json({success:true,data:mapQuotationRow(row,req.user)}); }
  catch(error) { return negotiationError(res,error); }
};
export const getQuotationNegotiation = async (req,res) => {
  try { return res.json({success:true,data:await getNegotiation({quotationId:req.params.id,actor:req.user})}); }
  catch(error) { return negotiationError(res,error); }
};
export const reviseQuotation = async (req,res) => {
  try { return res.status(201).json({success:true,data:await submitQuotationRevision({quotationId:req.params.id,actor:req.user,body:req.body})}); }
  catch(error) { return negotiationError(res,error); }
};
export const decideQuotation = async (req,res) => {
  try { return res.json({success:true,data:await decideQuotationRevision({quotationId:req.params.id,actor:req.user,body:req.body})}); }
  catch(error) { return negotiationError(res,error); }
};

export const updateQuotation = async (_req, res) => res.status(409).json({
  success:false,code:"SUBMITTED_QUOTATION_IMMUTABLE",
  message:"Submitted quotations can only change through a new requested revision."
});

export const deleteQuotation = async (_req, res) => res.status(409).json({
  success:false,code:"QUOTATION_HISTORY_IMMUTABLE",
  message:"Submitted quotation history cannot be deleted."
});

export const acceptQuotation = async (req, res) => {
  return res.status(409).json({
    success: false,
    code: "CLIENT_APPROVAL_REQUIRED",
    message: "Direct quotation acceptance is deprecated. Prepare and send a commercial proposal to the Client in the Inspection Workflow for commercial authorization.",
  });
};
