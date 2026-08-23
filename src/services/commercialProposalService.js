import { pool } from "../config/db.js";
import { writeAdminAudit } from "./adminAuditService.js";
import {
  createProposalApprovedNotification,
  createProposalRejectedNotification,
  createProposalSentNotification,
} from "./adminNotificationService.js";
import { calculateQuotationTotals } from "./quotationAcceptanceService.js";

const proposalError = (status, code, message) =>
  Object.assign(new Error(message), { status, code });

const positiveId = (value, name = "id") => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw proposalError(400, "INVALID_ID", `${name} must be a positive integer`);
  }
  return parsed;
};

export const calculateProposalFinancials = (quote, adminMarkupUsd = 0) => {
  const base = Number(quote?.total_quote_usd || 0);
  const expenses = [
    quote?.travel_cost,
    quote?.accommodation_cost,
    quote?.report_fee,
    quote?.urgency_surcharge,
  ].reduce((sum, val) => sum + (Number.isFinite(Number(val)) ? Number(val) : 0), 0);

  const totals = calculateQuotationTotals(quote, adminMarkupUsd);
  return {
    consultantBaseQuoteUsd: base,
    consultantExpensesUsd: expenses,
    consultantTotalUsd: totals.consultantTotalUsd,
    adminMarkupUsd: totals.markupUsd,
    clientTotalUsd: totals.clientTotalUsd,
  };
};

export const mapProposalRow = (row, user = {}) => {
  if (!row) return null;
  const roleId = Number(user.role_id || 0);

  const base = {
    id: Number(row.id),
    serviceRequestId: Number(row.service_request_id),
    quotationId: Number(row.quotation_id),
    expertId: Number(row.expert_id),
    revisionNumber: Number(row.revision_number),
    clientTotalUsd: Number(row.client_total_usd),
    currency: row.currency || "USD",
    clientNotes: row.client_notes || null,
    estimatedAttendanceDays: row.estimated_attendance_days != null ? Number(row.estimated_attendance_days) : null,
    status: row.status,
    sentAt: row.sent_at || null,
    decidedAt: row.decided_at || null,
    clientRejectionReason: row.client_rejection_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Expert public info if joined
    expertName: row.expert_name || null,
    expertRating: row.expert_rating != null ? Number(row.expert_rating) : null,
    expertLocation: row.expert_location || null,
    expertDiscipline: row.expert_discipline || null,
  };

  // Super Admin (Role 1) sees internal breakdowns and internal notes
  if (roleId === 1) {
    return {
      ...base,
      consultantBaseQuoteUsd: Number(row.consultant_base_quote_usd),
      consultantExpensesUsd: Number(row.consultant_expenses_usd),
      consultantTotalUsd: Number(row.consultant_total_usd),
      adminMarkupUsd: Number(row.admin_markup_usd),
      internalAdminNotes: row.internal_admin_notes || null,
      createdByUserId: row.created_by_user_id,
      sentByUserId: row.sent_by_user_id,
      decidedByUserId: row.decided_by_user_id,
    };
  }

  // Client (Role 3): strictly no internal markup, no consultant breakdown, no internal admin notes
  if (roleId === 3) {
    return {
      ...base,
      finalTotalUsd: Number(row.client_total_usd),
    };
  }

  // Consultant (Role 2): only sees consultant quote and neutral status if proposal is for them
  if (roleId === 2) {
    return {
      ...base,
      consultantTotalUsd: Number(row.consultant_total_usd),
      // Hide all client amounts & markups
      clientTotalUsd: undefined,
      finalTotalUsd: undefined,
    };
  }

  return base;
};

export const getProposalById = async (proposalIdValue, queryable = pool) => {
  const proposalId = positiveId(proposalIdValue, "proposalId");
  const result = await queryable.query(
    `
    SELECT cp.*,
           e.full_name AS expert_name,
           e.rating AS expert_rating,
           e.base_location AS expert_location,
           erd.discipline AS expert_discipline,
           sr.requester_user_id,
           sr.title AS request_title,
           sr.vessel_name,
           sr.service_type,
           sr.status AS request_status
      FROM commercial_proposals cp
      JOIN service_requests sr ON sr.id = cp.service_request_id
      JOIN experts e ON e.id = cp.expert_id
      LEFT JOIN expert_registration_details erd ON erd.expert_id = e.id
     WHERE cp.id = $1
    `,
    [proposalId]
  );
  return result.rows[0] || null;
};

export const getProposalsForRequest = async (requestIdValue, queryable = pool) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const result = await queryable.query(
    `
    SELECT cp.*,
           e.full_name AS expert_name,
           e.rating AS expert_rating,
           e.base_location AS expert_location,
           erd.discipline AS expert_discipline
      FROM commercial_proposals cp
      JOIN experts e ON e.id = cp.expert_id
      LEFT JOIN expert_registration_details erd ON erd.expert_id = e.id
     WHERE cp.service_request_id = $1
     ORDER BY cp.revision_number DESC, cp.id DESC
    `,
    [requestId]
  );
  return result.rows;
};

export const getActiveProposalForRequest = async (requestIdValue, queryable = pool) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const result = await queryable.query(
    `
    SELECT cp.*,
           e.full_name AS expert_name,
           e.rating AS expert_rating,
           e.base_location AS expert_location,
           erd.discipline AS expert_discipline
      FROM commercial_proposals cp
      JOIN experts e ON e.id = cp.expert_id
      LEFT JOIN expert_registration_details erd ON erd.expert_id = e.id
     WHERE cp.service_request_id = $1
       AND cp.status IN ('sent', 'approved', 'draft', 'rejected')
     ORDER BY CASE cp.status
                WHEN 'sent' THEN 1
                WHEN 'draft' THEN 2
                WHEN 'approved' THEN 3
                WHEN 'rejected' THEN 4
                ELSE 5
              END,
              cp.revision_number DESC
     LIMIT 1
    `,
    [requestId]
  );
  return result.rows[0] || null;
};

export const createOrUpdateDraftProposal = async ({
  requestId: rawRequestId,
  quotationId: rawQuotationId,
  adminMarkupUsd = 0,
  clientNotes = null,
  internalAdminNotes = null,
  estimatedAttendanceDays = null,
  actorUserId,
  queryable = pool,
}) => {
  const requestId = positiveId(rawRequestId, "requestId");
  const quotationId = positiveId(rawQuotationId, "quotationId");

  const quoteResult = await queryable.query(
    `
    SELECT q.*, sr.moderation_status, sr.status AS request_status
      FROM quotations q
      JOIN service_requests sr ON sr.id = q.service_request_id
     WHERE q.id = $1 AND q.service_request_id = $2
    `,
    [quotationId, requestId]
  );

  if (!quoteResult.rows.length) {
    throw proposalError(404, "QUOTATION_NOT_FOUND", "Quotation not found for this service request.");
  }
  const quote = quoteResult.rows[0];

  if (quote.moderation_status !== "approved") {
    throw proposalError(409, "REQUEST_NOT_APPROVED", "Service request must be approved by admin before preparing proposals.");
  }

  if (["assigned", "active", "completed"].includes(String(quote.request_status || "").toLowerCase())) {
    throw proposalError(409, "REQUEST_ALREADY_ASSIGNED", "Cannot prepare a new proposal for an already assigned request.");
  }

  if (!quote.expert_id) {
    throw proposalError(409, "QUOTATION_EXPERT_MISSING", "Quotation is missing an associated consultant profile.");
  }

  const financials = calculateProposalFinancials(quote, adminMarkupUsd);

  // Check if there is an existing draft for this request
  const existingDraft = await queryable.query(
    `SELECT * FROM commercial_proposals WHERE service_request_id = $1 AND status = 'draft' FOR UPDATE`,
    [requestId]
  );

  let proposal;
  if (existingDraft.rows.length) {
    const draftId = existingDraft.rows[0].id;
    const updated = await queryable.query(
      `
      UPDATE commercial_proposals
         SET quotation_id = $1,
             expert_id = $2,
             consultant_base_quote_usd = $3,
             consultant_expenses_usd = $4,
             consultant_total_usd = $5,
             admin_markup_usd = $6,
             client_total_usd = $7,
             client_notes = $8,
             internal_admin_notes = $9,
             estimated_attendance_days = $10,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = $11
       RETURNING *
      `,
      [
        quotationId,
        quote.expert_id,
        financials.consultantBaseQuoteUsd,
        financials.consultantExpensesUsd,
        financials.consultantTotalUsd,
        financials.adminMarkupUsd,
        financials.clientTotalUsd,
        clientNotes,
        internalAdminNotes,
        estimatedAttendanceDays || quote.attendance_days || null,
        draftId,
      ]
    );
    proposal = updated.rows[0];
  } else {
    // Determine next revision number
    const maxRevResult = await queryable.query(
      `SELECT COALESCE(MAX(revision_number), 0) AS max_rev FROM commercial_proposals WHERE service_request_id = $1`,
      [requestId]
    );
    const nextRevision = Number(maxRevResult.rows[0].max_rev) + 1;

    const created = await queryable.query(
      `
      INSERT INTO commercial_proposals (
        service_request_id,
        quotation_id,
        expert_id,
        revision_number,
        consultant_base_quote_usd,
        consultant_expenses_usd,
        consultant_total_usd,
        admin_markup_usd,
        client_total_usd,
        client_notes,
        internal_admin_notes,
        estimated_attendance_days,
        status,
        created_by_user_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13)
      RETURNING *
      `,
      [
        requestId,
        quotationId,
        quote.expert_id,
        nextRevision,
        financials.consultantBaseQuoteUsd,
        financials.consultantExpensesUsd,
        financials.consultantTotalUsd,
        financials.adminMarkupUsd,
        financials.clientTotalUsd,
        clientNotes,
        internalAdminNotes,
        estimatedAttendanceDays || quote.attendance_days || null,
        actorUserId,
      ]
    );
    proposal = created.rows[0];

    await writeAdminAudit(queryable, {
      actorUserId,
      action: "commercial_proposal.created",
      targetType: "commercial_proposal",
      targetId: proposal.id,
      summary: `Created draft proposal Revision #${proposal.revision_number} for request #${requestId}`,
    });
  }

  // Update inspection workflow selected quotation if workflow exists
  await queryable.query(
    `
    UPDATE inspection_workflows
       SET selected_quotation_id = $1,
           current_stage = CASE WHEN current_stage = 'overview' THEN 'confirm' ELSE current_stage END,
           updated_at = CURRENT_TIMESTAMP
     WHERE service_request_id = $2
    `,
    [quotationId, requestId]
  );

  return getProposalById(proposal.id, queryable);
};

export const sendProposalToClient = async ({
  requestId: rawRequestId,
  proposalId: rawProposalId,
  actorUserId,
  queryable = pool,
}) => {
  const requestId = positiveId(rawRequestId, "requestId");
  const proposalId = rawProposalId ? positiveId(rawProposalId, "proposalId") : null;

  // Lock request and target proposal
  const requestResult = await queryable.query(
    `SELECT * FROM service_requests WHERE id = $1 FOR UPDATE`,
    [requestId]
  );
  if (!requestResult.rows.length) {
    throw proposalError(404, "REQUEST_NOT_FOUND", "Service request not found.");
  }
  const request = requestResult.rows[0];

  if (request.moderation_status !== "approved") {
    throw proposalError(409, "REQUEST_NOT_APPROVED", "Service request must finish admin moderation before sending proposals.");
  }
  if (["assigned", "active", "completed"].includes(String(request.status || "").toLowerCase())) {
    throw proposalError(409, "REQUEST_ALREADY_ASSIGNED", "This service request is already assigned to a surveyor.");
  }

  let targetProposalQuery;
  if (proposalId) {
    targetProposalQuery = await queryable.query(
      `SELECT * FROM commercial_proposals WHERE id = $1 AND service_request_id = $2 FOR UPDATE`,
      [proposalId, requestId]
    );
  } else {
    targetProposalQuery = await queryable.query(
      `SELECT * FROM commercial_proposals WHERE service_request_id = $1 AND status = 'draft' ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [requestId]
    );
  }

  if (!targetProposalQuery.rows.length) {
    throw proposalError(404, "PROPOSAL_NOT_FOUND", "No eligible proposal found to send.");
  }
  const proposal = targetProposalQuery.rows[0];

  if (proposal.status === "sent") {
    // Idempotent: already sent
    return getProposalById(proposal.id, queryable);
  }

  if (proposal.status !== "draft") {
    throw proposalError(409, "PROPOSAL_NOT_DRAFT", `Only draft proposals can be sent. Current status: ${proposal.status}`);
  }

  // Supersede any previously active sent proposal for this request
  await queryable.query(
    `
    UPDATE commercial_proposals
       SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
     WHERE service_request_id = $1
       AND status = 'sent'
       AND id <> $2
    `,
    [requestId, proposal.id]
  );

  // Mark proposal as sent
  const updatedProposal = await queryable.query(
    `
    UPDATE commercial_proposals
       SET status = 'sent',
           sent_by_user_id = $1,
           sent_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = $2
     RETURNING *
    `,
    [actorUserId, proposal.id]
  );

  // Update service request active proposal and status to pending_client_approval
  await queryable.query(
    `
    UPDATE service_requests
       SET active_proposal_id = $1,
           status = 'pending_client_approval',
           updated_at = CURRENT_TIMESTAMP
     WHERE id = $2
    `,
    [proposal.id, requestId]
  );

  // In-app notification to client owner
  if (request.requester_user_id) {
    await createProposalSentNotification(queryable, {
      requestId,
      recipientUserId: request.requester_user_id,
      revisionNumber: proposal.revision_number,
      clientTotalUsd: proposal.client_total_usd,
      vesselName: request.vessel_name,
      serviceName: request.service_category || request.service_type,
    });
  }

  // Audit log
  await writeAdminAudit(queryable, {
    actorUserId,
    action: "commercial_proposal.sent",
    targetType: "commercial_proposal",
    targetId: proposal.id,
    summary: `Sent commercial proposal Revision #${proposal.revision_number} ($${proposal.client_total_usd}) to Client for request #${requestId}`,
  });

  return getProposalById(proposal.id, queryable);
};

export const supersedeProposal = async ({
  requestId: rawRequestId,
  proposalId: rawProposalId,
  actorUserId,
  queryable = pool,
}) => {
  const requestId = positiveId(rawRequestId, "requestId");
  const proposalId = positiveId(rawProposalId, "proposalId");

  const proposalResult = await queryable.query(
    `SELECT * FROM commercial_proposals WHERE id = $1 AND service_request_id = $2 FOR UPDATE`,
    [proposalId, requestId]
  );
  if (!proposalResult.rows.length) {
    throw proposalError(404, "PROPOSAL_NOT_FOUND", "Proposal not found.");
  }
  const proposal = proposalResult.rows[0];

  if (!["draft", "sent"].includes(proposal.status)) {
    throw proposalError(409, "PROPOSAL_NOT_CANCELLABLE", `Cannot recall/supersede proposal in status: ${proposal.status}`);
  }

  await queryable.query(
    `
    UPDATE commercial_proposals
       SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
    `,
    [proposalId]
  );

  // Reset request active status if it was pending_client_approval
  await queryable.query(
    `
    UPDATE service_requests
       SET status = CASE WHEN status = 'pending_client_approval' THEN 'open' ELSE status END,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
    `,
    [requestId]
  );

  await writeAdminAudit(queryable, {
    actorUserId,
    action: "commercial_proposal.superseded",
    targetType: "commercial_proposal",
    targetId: proposal.id,
    summary: `Superseded proposal Revision #${proposal.revision_number} for request #${requestId}`,
  });

  return getProposalById(proposal.id, queryable);
};

export const rejectProposalByClient = async ({
  proposalId: rawProposalId,
  rejectionReason: rawReason,
  actorUserId,
  queryable = pool,
}) => {
  const proposalId = positiveId(rawProposalId, "proposalId");
  const rejectionReason = String(rawReason || "").trim();

  if (!rejectionReason) {
    throw proposalError(400, "REJECTION_REASON_REQUIRED", "A reason is required when declining a commercial proposal.");
  }
  if (rejectionReason.length > 1000) {
    throw proposalError(400, "REJECTION_REASON_TOO_LONG", "Rejection reason must be 1000 characters or fewer.");
  }

  const proposalResult = await queryable.query(
    `
    SELECT cp.*, sr.requester_user_id, sr.vessel_name, sr.status AS request_status
      FROM commercial_proposals cp
      JOIN service_requests sr ON sr.id = cp.service_request_id
     WHERE cp.id = $1 FOR UPDATE OF cp, sr
    `,
    [proposalId]
  );

  if (!proposalResult.rows.length) {
    throw proposalError(404, "PROPOSAL_NOT_FOUND", "Proposal not found.");
  }
  const proposal = proposalResult.rows[0];

  // Verify ownership
  if (Number(proposal.requester_user_id) !== Number(actorUserId)) {
    throw proposalError(403, "NOT_REQUEST_OWNER", "Only the client who created this service request can decline this proposal.");
  }

  if (proposal.status === "rejected") {
    // Idempotent return
    return getProposalById(proposal.id, queryable);
  }

  if (proposal.status === "superseded") {
    throw proposalError(409, "PROPOSAL_SUPERSEDED", "This proposal was superseded by an updated revision and cannot be decided upon.");
  }

  if (proposal.status !== "sent") {
    throw proposalError(409, "PROPOSAL_NOT_DECIDABLE", `This proposal is not available for a decision (Status: ${proposal.status}).`);
  }

  // Update proposal to rejected
  const updatedProposal = await queryable.query(
    `
    UPDATE commercial_proposals
       SET status = 'rejected',
           client_rejection_reason = $1,
           decided_by_user_id = $2,
           decided_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = $3
     RETURNING *
    `,
    [rejectionReason, actorUserId, proposalId]
  );

  // Return request status to open while preserving active proposal reference
  await queryable.query(
    `
    UPDATE service_requests
       SET status = 'open',
           updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
    `,
    [proposal.service_request_id]
  );

  // Notify Super Admins
  await createProposalRejectedNotification(queryable, {
    requestId: proposal.service_request_id,
    proposalId: proposal.id,
    revisionNumber: proposal.revision_number,
    rejectionReason,
    vesselName: proposal.vessel_name,
  });

  // Write audit
  await writeAdminAudit(queryable, {
    actorUserId,
    action: "commercial_proposal.client_rejected",
    targetType: "commercial_proposal",
    targetId: proposal.id,
    summary: `Client declined commercial proposal Revision #${proposal.revision_number} for request #${proposal.service_request_id}`,
    reason: rejectionReason,
  });

  return getProposalById(proposal.id, queryable);
};

export const approveProposalByClient = async ({
  proposalId: rawProposalId,
  actorUserId,
  queryable = pool,
}) => {
  const proposalId = positiveId(rawProposalId, "proposalId");

  // Lock proposal, service_request, and quotation in a single transaction
  const proposalResult = await queryable.query(
    `
    SELECT cp.*,
           sr.requester_user_id,
           sr.moderation_status,
           sr.status AS request_status,
           sr.vessel_name,
           q.total_quote_usd,
           q.expert_user_id
      FROM commercial_proposals cp
      JOIN service_requests sr ON sr.id = cp.service_request_id
      JOIN quotations q ON q.id = cp.quotation_id
     WHERE cp.id = $1 FOR UPDATE OF cp, sr, q
    `,
    [proposalId]
  );

  if (!proposalResult.rows.length) {
    throw proposalError(404, "PROPOSAL_NOT_FOUND", "Proposal not found.");
  }
  const proposal = proposalResult.rows[0];

  // Verify ownership
  if (Number(proposal.requester_user_id) !== Number(actorUserId)) {
    throw proposalError(403, "NOT_REQUEST_OWNER", "Only the client who created this service request can approve this proposal.");
  }

  if (proposal.status === "approved") {
    // Idempotent
    return {
      proposal: await getProposalById(proposal.id, queryable),
      serviceRequestId: proposal.service_request_id,
      expertId: proposal.expert_id,
      alreadyApproved: true,
    };
  }

  if (proposal.status === "superseded") {
    throw proposalError(409, "PROPOSAL_SUPERSEDED", "This proposal was superseded by an updated revision and cannot be approved.");
  }

  if (proposal.status !== "sent") {
    throw proposalError(409, "PROPOSAL_NOT_DECIDABLE", `This proposal is not in sent state for approval (Current status: ${proposal.status}).`);
  }

  if (proposal.moderation_status !== "approved") {
    throw proposalError(409, "REQUEST_NOT_APPROVED", "Service request must be approved.");
  }

  // 1. Mark proposal as approved
  const approvedProposal = await queryable.query(
    `
    UPDATE commercial_proposals
       SET status = 'approved',
           decided_by_user_id = $1,
           decided_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = $2
     RETURNING *
    `,
    [actorUserId, proposalId]
  );

  // 2. Reject competing quotations for this request
  await queryable.query(
    `
    UPDATE quotations
       SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
     WHERE service_request_id = $1
       AND id <> $2
       AND status IN ('pending', 'submitted')
    `,
    [proposal.service_request_id, proposal.quotation_id]
  );

  // 3. Mark selected quotation as accepted
  await queryable.query(
    `
    UPDATE quotations
       SET status = 'accepted',
           admin_markup_usd = $1,
           client_total_usd = $2,
           accepted_by_user_id = $3,
           accepted_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = $4
    `,
    [
      proposal.admin_markup_usd,
      proposal.client_total_usd,
      proposal.sent_by_user_id || actorUserId,
      proposal.quotation_id,
    ]
  );

  // 4. Update service_requests with accepted quotation, accepted expert, and status = assigned
  await queryable.query(
    `
    UPDATE service_requests
       SET accepted_quotation_id = $1,
           accepted_expert_id = $2,
           active_proposal_id = $3,
           budget_usd = $4,
           status = 'assigned',
           updated_at = CURRENT_TIMESTAMP
     WHERE id = $5
    `,
    [
      proposal.quotation_id,
      proposal.expert_id,
      proposal.id,
      proposal.client_total_usd,
      proposal.service_request_id,
    ]
  );

  // 5. Create/update request_expert_assignments row
  await queryable.query(
    `
    INSERT INTO request_expert_assignments (
      service_request_id,
      expert_id,
      assigned_by_user_id
    ) VALUES ($1, $2, $3)
    ON CONFLICT (service_request_id, expert_id)
    DO UPDATE SET assigned_by_user_id = EXCLUDED.assigned_by_user_id, updated_at = CURRENT_TIMESTAMP
    `,
    [proposal.service_request_id, proposal.expert_id, proposal.sent_by_user_id || actorUserId]
  );

  // 6. Advance inspection_workflows to surveyor stage if exists
  await queryable.query(
    `
    UPDATE inspection_workflows
       SET current_stage = 'surveyor',
           selected_quotation_id = $1,
           updated_at = CURRENT_TIMESTAMP
     WHERE service_request_id = $2
    `,
    [proposal.quotation_id, proposal.service_request_id]
  );

  // 7. Write audit events
  await writeAdminAudit(queryable, {
    actorUserId,
    action: "commercial_proposal.client_approved",
    targetType: "commercial_proposal",
    targetId: proposal.id,
    summary: `Client approved commercial proposal Revision #${proposal.revision_number} ($${proposal.client_total_usd}) for request #${proposal.service_request_id}`,
  });

  await writeAdminAudit(queryable, {
    actorUserId,
    action: "inspection_workflow.quotation_confirmed",
    targetType: "quotation",
    targetId: proposal.quotation_id,
    summary: `Confirmed quotation ${proposal.quotation_id} via Client commercial approval`,
  });

  await writeAdminAudit(queryable, {
    actorUserId,
    action: "inspection_workflow.surveyor_confirmed",
    targetType: "expert",
    targetId: proposal.expert_id,
    summary: `Assigned Consultant ${proposal.expert_id} to request ${proposal.service_request_id}`,
  });

  // 8. Notifications
  await createProposalApprovedNotification(queryable, {
    requestId: proposal.service_request_id,
    proposalId: proposal.id,
    clientTotalUsd: proposal.client_total_usd,
    consultantUserId: proposal.expert_user_id,
    vesselName: proposal.vessel_name,
  });

  return {
    proposal: await getProposalById(proposal.id, queryable),
    serviceRequestId: proposal.service_request_id,
    expertId: proposal.expert_id,
    alreadyApproved: false,
  };
};
