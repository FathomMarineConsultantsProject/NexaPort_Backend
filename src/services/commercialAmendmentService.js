const fail = (code, message) => { throw Object.assign(new Error(message), { status: 409, code }); };

// Call only after locking service_requests. Invoice/completion writers lock the
// same request, so eligibility cannot change during this transaction. A plain
// workflow read avoids taking locks in the opposite order to closeout writers.
export const requireAmendmentEligible = async (db, requestId) => {
  const workflow = (await db.query("SELECT * FROM inspection_workflows WHERE service_request_id=$1", [requestId])).rows[0];
  if (workflow?.completed_at || ["invoice_submitted", "invoice_approved", "invoice_paid"].includes(workflow?.current_stage))
    fail("FINANCIAL_ADJUSTMENT_REQUIRED", "Completed inspections require an explicit financial adjustment workflow, which is not supported.");
  const invoice = (await db.query(`SELECT ii.id FROM inspection_invoices ii JOIN inspection_workflows iw ON iw.id=ii.workflow_id WHERE iw.service_request_id=$1 LIMIT 1`, [requestId])).rows[0];
  if (invoice) fail("FINANCIAL_ADJUSTMENT_REQUIRED", "Invoiced or paid requests require an explicit financial adjustment workflow, which is not supported.");
};

export const getAcceptedAgreement = async (db, requestId) => (await db.query(`
  SELECT cp.*, sr.status AS request_status FROM commercial_proposals cp JOIN service_requests sr ON sr.active_proposal_id=cp.id
  WHERE sr.id=$1 AND cp.service_request_id=sr.id AND cp.status='approved'
    AND cp.decided_by_user_id=sr.requester_user_id AND cp.decided_at IS NOT NULL FOR UPDATE OF cp`, [requestId])).rows[0] || null;

export const requireAmendmentParent = async (db, requestId, parentId, quoteId, expertId) => {
  await requireAmendmentEligible(db, requestId);
  const accepted = await getAcceptedAgreement(db, requestId);
  if (accepted?.request_status === "completed") fail("FINANCIAL_ADJUSTMENT_REQUIRED", "Completed requests require an explicit financial adjustment workflow, which is not supported.");
  if (!accepted || Number(accepted.id) !== Number(parentId) || Number(accepted.quotation_id) !== Number(quoteId) || Number(accepted.expert_id) !== Number(expertId))
    fail("STALE_AMENDMENT", "The accepted agreement changed. Create an amendment against the current approved proposal; the assigned Consultant cannot be changed here.");
  return accepted;
};
