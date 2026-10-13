// Only stored Client-facing snapshots are eligible. Never substitute purchase cost.
export const clientQuotationPrice = (row) => {
  const raw = row.client_total_usd ?? row.authorized_client_total_usd;
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
};
export const authorizedClientPriceSql = (alias = "q") => `(SELECT cp.client_total_usd FROM commercial_proposals cp
  JOIN service_requests owner_request ON owner_request.id=cp.service_request_id
  WHERE cp.quotation_id=${alias}.id AND cp.service_request_id=${alias}.service_request_id
    AND cp.expert_id=${alias}.expert_id AND cp.status='approved' AND cp.decided_at IS NOT NULL
    AND cp.decided_by_user_id=owner_request.requester_user_id
  ORDER BY cp.decided_at DESC NULLS LAST,cp.id DESC LIMIT 1)`;
