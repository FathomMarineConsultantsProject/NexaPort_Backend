import { pool } from "../config/db.js";

const mapQuotationRow = (row) => ({
  id: row.id,
  serviceRequestId: row.service_request_id,
  expertId: row.expert_id,
  expertName: row.expert_name,
  expertRating: Number(row.expert_rating || 0),
  expertLocation: row.expert_location,
  totalQuoteUsd: Number(row.total_quote_usd || 0),
  attendanceDays: row.attendance_days,
  travelCost: Number(row.travel_cost || 0),
  accommodationCost: Number(row.accommodation_cost || 0),
  reportFee: Number(row.report_fee || 0),
  urgencySurcharge: Number(row.urgency_surcharge || 0),
  coverLetter: row.cover_letter,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

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

    const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT
        q.*,
        e.full_name AS expert_name,
        e.rating AS expert_rating,
        e.base_location AS expert_location
      FROM quotations q
      LEFT JOIN experts e ON e.id = q.expert_id
      ${whereSql}
      ORDER BY q.created_at DESC
      `,
      values
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows.map(mapQuotationRow),
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
        q.*,
        e.full_name AS expert_name,
        e.rating AS expert_rating,
        e.base_location AS expert_location
      FROM quotations q
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

    res.json({
      success: true,
      data: mapQuotationRow(result.rows[0]),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch quotation",
      error: error.message,
    });
  }
};

export const createQuotation = async (req, res) => {
  try {
    const {
      serviceRequestId,
      expertId,
      totalQuoteUsd,
      attendanceDays,
      travelCost,
      accommodationCost,
      reportFee,
      urgencySurcharge,
      coverLetter,
    } = req.body;

    if (!serviceRequestId || !totalQuoteUsd) {
      return res.status(400).json({
        success: false,
        message: "serviceRequestId and totalQuoteUsd are required",
      });
    }

    const requestCheck = await pool.query(
      `SELECT id FROM service_requests WHERE id = $1`,
      [serviceRequestId]
    );

    if (!requestCheck.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Service request not found",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO quotations (
        service_request_id,
        expert_id,
        total_quote_usd,
        attendance_days,
        travel_cost,
        accommodation_cost,
        report_fee,
        urgency_surcharge,
        cover_letter
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
      `,
      [
        serviceRequestId,
        expertId || null,
        totalQuoteUsd,
        attendanceDays || null,
        travelCost || 0,
        accommodationCost || 0,
        reportFee || 0,
        urgencySurcharge || 0,
        coverLetter || null,
      ]
    );

    res.status(201).json({
      success: true,
      message: "Quotation submitted successfully",
      data: mapQuotationRow(result.rows[0]),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to submit quotation",
      error: error.message,
    });
  }
};

export const updateQuotation = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      expertId,
      totalQuoteUsd,
      attendanceDays,
      travelCost,
      accommodationCost,
      reportFee,
      urgencySurcharge,
      coverLetter,
      status,
    } = req.body;

    const result = await pool.query(
      `
      UPDATE quotations
      SET
        expert_id = COALESCE($1, expert_id),
        total_quote_usd = COALESCE($2, total_quote_usd),
        attendance_days = COALESCE($3, attendance_days),
        travel_cost = COALESCE($4, travel_cost),
        accommodation_cost = COALESCE($5, accommodation_cost),
        report_fee = COALESCE($6, report_fee),
        urgency_surcharge = COALESCE($7, urgency_surcharge),
        cover_letter = COALESCE($8, cover_letter),
        status = COALESCE($9, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $10
      RETURNING *
      `,
      [
        expertId || null,
        totalQuoteUsd || null,
        attendanceDays || null,
        travelCost || null,
        accommodationCost || null,
        reportFee || null,
        urgencySurcharge || null,
        coverLetter || null,
        status || null,
        id,
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Quotation not found",
      });
    }

    res.json({
      success: true,
      message: "Quotation updated successfully",
      data: mapQuotationRow(result.rows[0]),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update quotation",
      error: error.message,
    });
  }
};

export const updateQuotationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!["accepted", "rejected", "pending"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid quotation status",
      });
    }

    const result = await pool.query(
      `
      UPDATE quotations
      SET status = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
      `,
      [status, id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Quotation not found",
      });
    }

    res.json({
      success: true,
      message: `Quotation ${status} successfully`,
      data: mapQuotationRow(result.rows[0]),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update quotation status",
      error: error.message,
    });
  }
};

export const deleteQuotation = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      DELETE FROM quotations
      WHERE id = $1
      RETURNING id
      `,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Quotation not found",
      });
    }

    res.json({
      success: true,
      message: "Quotation deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete quotation",
      error: error.message,
    });
  }
};