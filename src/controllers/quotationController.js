import { pool } from "../config/db.js";

const mapQuotationRow = (row, user) => {
  const roleId = Number(user.role_id);

  const base = {
    id: row.id,
    serviceRequestId: row.service_request_id,
    status: row.status,
    attendanceDays: row.attendance_days,
    coverLetter: row.cover_letter,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    return {
      ...base,
      expertId: row.status === "accepted" ? row.expert_id : null,
      expertName: row.status === "accepted" ? row.expert_name : null,
      expertRating: row.status === "accepted" ? Number(row.expert_rating || 0) : null,
      expertLocation: row.status === "accepted" ? row.expert_location : null,
      finalTotalUsd: Number(row.client_total_usd || 0),
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
        q.*,
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
        q.*,
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

export const createQuotation = async (req, res) => {
  try {
    const {
      serviceRequestId,
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
      `
      SELECT id, status
      FROM service_requests
      WHERE id = $1
      `,
      [serviceRequestId]
    );

    if (!requestCheck.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Service request not found",
      });
    }

    const expertCheck = await pool.query(
      `
      SELECT id
      FROM experts
      WHERE user_id = $1
      `,
      [req.user.id]
    );

    if (Number(req.user.role_id) === 2 && !expertCheck.rows.length) {
      return res.status(400).json({
        success: false,
        message: "Expert profile is required before submitting quotation",
      });
    }

    const expertId =
      Number(req.user.role_id) === 2 ? expertCheck.rows[0].id : req.body.expertId;

    const result = await pool.query(
      `
      INSERT INTO quotations (
        service_request_id,
        expert_id,
        expert_user_id,
        total_quote_usd,
        attendance_days,
        travel_cost,
        accommodation_cost,
        report_fee,
        urgency_surcharge,
        cover_letter
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
      `,
      [
        serviceRequestId,
        expertId || null,
        req.user.id,
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
      data: mapQuotationRow(result.rows[0], req.user),
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

    const existing = await pool.query(
      `
      SELECT
        q.*,
        sr.requester_user_id
      FROM quotations q
      LEFT JOIN service_requests sr ON sr.id = q.service_request_id
      WHERE q.id = $1
      `,
      [id]
    );

    if (!existing.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Quotation not found",
      });
    }

    if (!canAccessQuotation(req.user, existing.rows[0])) {
      return res.status(403).json({
        success: false,
        message: "Only admin or quotation owner can update this quotation",
      });
    }

    const {
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
        total_quote_usd = COALESCE($1, total_quote_usd),
        attendance_days = COALESCE($2, attendance_days),
        travel_cost = COALESCE($3, travel_cost),
        accommodation_cost = COALESCE($4, accommodation_cost),
        report_fee = COALESCE($5, report_fee),
        urgency_surcharge = COALESCE($6, urgency_surcharge),
        cover_letter = COALESCE($7, cover_letter),
        status = COALESCE($8, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $9
      RETURNING *
      `,
      [
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

    res.json({
      success: true,
      message: "Quotation updated successfully",
      data: mapQuotationRow(result.rows[0], req.user),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update quotation",
      error: error.message,
    });
  }
};

export const deleteQuotation = async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query(
      `
      SELECT
        q.*,
        sr.requester_user_id
      FROM quotations q
      LEFT JOIN service_requests sr ON sr.id = q.service_request_id
      WHERE q.id = $1
      `,
      [id]
    );

    if (!existing.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Quotation not found",
      });
    }

    if (!canAccessQuotation(req.user, existing.rows[0])) {
      return res.status(403).json({
        success: false,
        message: "Only admin or quotation owner can delete this quotation",
      });
    }

    await pool.query(`DELETE FROM quotations WHERE id = $1`, [id]);

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

export const acceptQuotation = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const { adminMarkupUsd = 0 } = req.body;

    await client.query("BEGIN");

    const quoteResult = await client.query(
      `
      SELECT id, service_request_id, expert_id, total_quote_usd
      FROM quotations
      WHERE id = $1
      `,
      [id]
    );

    if (!quoteResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Quotation not found",
      });
    }

    const quote = quoteResult.rows[0];

    const expertQuoteUsd = Number(quote.total_quote_usd || 0);
    const markupUsd = Number(adminMarkupUsd || 0);
    const clientTotalUsd = expertQuoteUsd + markupUsd;

    await client.query(
      `
      UPDATE quotations
      SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
      WHERE service_request_id = $1
      `,
      [quote.service_request_id]
    );

    const acceptedQuote = await client.query(
      `
      UPDATE quotations
      SET
        status = 'accepted',
        admin_markup_usd = $1,
        client_total_usd = $2,
        accepted_by_user_id = $3,
        accepted_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
      `,
      [markupUsd, clientTotalUsd, req.user.id, id]
    );

    await client.query(
      `
      UPDATE service_requests
      SET
        accepted_quotation_id = $1,
        accepted_expert_id = $2,
        budget_usd = $3,
        status = 'assigned',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      `,
      [quote.id, quote.expert_id, clientTotalUsd, quote.service_request_id]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Quotation accepted successfully",
      data: acceptedQuote.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");

    res.status(500).json({
      success: false,
      message: "Failed to accept quotation",
      error: error.message,
    });
  } finally {
    client.release();
  }
};