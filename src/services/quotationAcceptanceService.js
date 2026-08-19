const finiteNumber = (value) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
};

export const calculateQuotationTotals = (quote, adminMarkupUsd = 0) => {
  const consultantTotalUsd = [
    quote.total_quote_usd,
    quote.travel_cost,
    quote.accommodation_cost,
    quote.report_fee,
    quote.urgency_surcharge,
  ].reduce((total, value) => total + finiteNumber(value), 0);
  const markupUsd = finiteNumber(adminMarkupUsd);
  if (markupUsd < 0) {
    const error = new Error("Admin quotation fee cannot be negative");
    error.status = 400;
    throw error;
  }
  return { consultantTotalUsd, markupUsd, clientTotalUsd: consultantTotalUsd + markupUsd };
};

export const acceptQuotationOperation = async ({
  queryable,
  quotationId,
  adminMarkupUsd = 0,
  actorUserId,
}) => {
  const quoteResult = await queryable.query(
    `SELECT q.id, q.service_request_id, q.expert_id, q.status, q.total_quote_usd,
            q.travel_cost, q.accommodation_cost, q.report_fee, q.urgency_surcharge,
            sr.moderation_status, sr.accepted_quotation_id
       FROM quotations q
       JOIN service_requests sr ON sr.id=q.service_request_id
      WHERE q.id=$1 FOR UPDATE OF q, sr`,
    [quotationId]
  );
  if (!quoteResult.rows.length) {
    throw Object.assign(new Error("Quotation not found"), { status: 404, code: "QUOTATION_NOT_FOUND" });
  }
  const quote = quoteResult.rows[0];
  if (quote.moderation_status !== "approved") {
    throw Object.assign(new Error("Service request must be approved before accepting a quotation"), { status: 409, code: "REQUEST_NOT_APPROVED" });
  }
  if (!quote.expert_id) {
    throw Object.assign(new Error("Quotation has no Consultant profile"), { status: 409, code: "QUOTATION_EXPERT_MISSING" });
  }
  if (quote.status === "accepted" && Number(quote.accepted_quotation_id) === Number(quote.id)) {
    const existing = await queryable.query("SELECT * FROM quotations WHERE id=$1", [quote.id]);
    return { quotation: existing.rows[0], serviceRequestId: quote.service_request_id, expertId: quote.expert_id, alreadyAccepted: true };
  }
  if (!["pending", "submitted"].includes(String(quote.status || "").toLowerCase())) {
    throw Object.assign(new Error("Quotation is no longer available for acceptance"), { status: 409, code: "QUOTATION_NOT_ELIGIBLE" });
  }
  if (quote.accepted_quotation_id && Number(quote.accepted_quotation_id) !== Number(quote.id)) {
    throw Object.assign(new Error("Another quotation has already been accepted"), { status: 409, code: "QUOTATION_ALREADY_ACCEPTED" });
  }

  const { markupUsd, clientTotalUsd } = calculateQuotationTotals(quote, adminMarkupUsd);
  await queryable.query(
    `UPDATE quotations SET status='rejected', updated_at=CURRENT_TIMESTAMP
      WHERE service_request_id=$1 AND id<>$2 AND status IN ('pending','submitted')`,
    [quote.service_request_id, quote.id]
  );
  const accepted = await queryable.query(
    `UPDATE quotations SET status='accepted', admin_markup_usd=$1, client_total_usd=$2,
       accepted_by_user_id=$3, accepted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
     WHERE id=$4 RETURNING *`,
    [markupUsd, clientTotalUsd, actorUserId, quote.id]
  );
  await queryable.query(
    `UPDATE service_requests SET accepted_quotation_id=$1, accepted_expert_id=$2,
       budget_usd=$3, status='assigned', updated_at=CURRENT_TIMESTAMP WHERE id=$4`,
    [quote.id, quote.expert_id, clientTotalUsd, quote.service_request_id]
  );
  await queryable.query(
    `INSERT INTO request_expert_assignments(service_request_id,expert_id,assigned_by_user_id)
     VALUES($1,$2,$3) ON CONFLICT(service_request_id,expert_id)
     DO UPDATE SET assigned_by_user_id=EXCLUDED.assigned_by_user_id,updated_at=CURRENT_TIMESTAMP`,
    [quote.service_request_id, quote.expert_id, actorUserId]
  );
  return { quotation: accepted.rows[0], serviceRequestId: quote.service_request_id, expertId: quote.expert_id, alreadyAccepted: false };
};
