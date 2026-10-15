// Agent contact data is request-specific. Marketplace access never grants disclosure.
export const agentDetailsForRole = (row, roleId, assigned = false) => {
  if (Number(roleId) === 1) return {
    companyName: row.agent_company_name || null,
    contactName: row.agent_contact_name || null,
    email: row.agent_email || null,
    phone: row.agent_phone || null,
  };
  if (Number(roleId) === 2 && assigned && row.agent_contact_name) {
    return { contactName: row.agent_contact_name };
  }
  return undefined;
};

export const consultantHasConfirmedAgentAccess = async (db, requestId, userId) => {
  const result = await db.query(`SELECT 1 FROM service_requests sr
    JOIN commercial_proposals cp ON cp.id=sr.active_proposal_id
      AND cp.service_request_id=sr.id AND cp.status='approved'
      AND cp.decided_by_user_id=sr.requester_user_id
    JOIN experts e ON e.id=sr.accepted_expert_id AND e.user_id=$2
    JOIN request_expert_assignments rea ON rea.service_request_id=sr.id AND rea.expert_id=e.id
    WHERE sr.id=$1 AND sr.moderation_status='approved'
      AND cp.expert_id=e.id AND cp.quotation_id=sr.accepted_quotation_id
    LIMIT 1`, [requestId, userId]);
  return result.rowCount > 0;
};

export const clientAgentReplacement = (body) => {
  const next = { ...body };
  for (const key of ["agentCompanyName", "agentContactName", "agentEmail", "agentPhone"]) {
    if (next[key] == null || String(next[key]).trim() === "") delete next[key];
  }
  return next;
};
