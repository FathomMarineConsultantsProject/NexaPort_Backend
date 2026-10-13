import { pool } from "../config/db.js";
import { getAuthorizedQuotationRevision } from "./quotationAuthorizationService.js";
import { writeAdminAudit } from "./adminAuditService.js";

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const id = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0
  ? Number(value) : fail(400, "INVALID_ID", "A valid request and Expert ID are required");

// request_expert_assignments is an operational source for reports and dashboards.
// It is not an invitation list. This endpoint can only confirm the accepted Expert.
export const confirmAcceptedExpertAssignment = async ({ requestId: rawId, expertIds, actor, connectionPool = pool }) => {
  if (Number(actor?.role_id) !== 1) fail(403, "ACCESS_DENIED", "Super Admin access is required");
  const requestId = id(rawId);
  if (!Array.isArray(expertIds) || expertIds.length !== 1) fail(400, "ONE_ACCEPTED_EXPERT_REQUIRED", "Choose the single Client-approved Expert");
  const expertId = id(expertIds[0]);
  const db = await connectionPool.connect();
  try {
    await db.query("BEGIN");
    const request = (await db.query("SELECT * FROM service_requests WHERE id=$1 FOR UPDATE", [requestId])).rows[0];
    if (!request) fail(404, "REQUEST_NOT_FOUND", "Service request not found");
    if (request.moderation_status !== "approved" || !["assigned", "active"].includes(request.status))
      fail(409, "CLIENT_APPROVAL_REQUIRED", "An approved operational request is required");
    const proposal = (await db.query("SELECT * FROM commercial_proposals WHERE id=$1 AND service_request_id=$2 FOR UPDATE", [request.active_proposal_id, requestId])).rows[0];
    if (!proposal || proposal.status !== "approved" || !proposal.decided_at ||
        Number(proposal.decided_by_user_id) !== Number(request.requester_user_id))
      fail(409, "CLIENT_APPROVAL_REQUIRED", "A proposal approved by the request owner is required");
    if (Number(proposal.expert_id) !== expertId || Number(request.accepted_expert_id) !== expertId ||
        Number(request.accepted_quotation_id) !== Number(proposal.quotation_id))
      fail(409, "ASSIGNMENT_MISMATCH", "Assignment must match the Client-approved proposal");
    const quote = (await db.query("SELECT * FROM quotations WHERE id=$1 AND service_request_id=$2 FOR UPDATE", [proposal.quotation_id, requestId])).rows[0];
    if (!quote || quote.status !== "accepted" || Number(quote.expert_id) !== expertId ||
        !await getAuthorizedQuotationRevision(db, quote.id, proposal.approved_quotation_revision_id))
      fail(409, "QUOTATION_INTERNAL_APPROVAL_REQUIRED", "The accepted quotation revision must be authorized");
    const existing = (await db.query("SELECT expert_id FROM request_expert_assignments WHERE service_request_id=$1", [requestId])).rows;
    if (existing.some((row) => Number(row.expert_id) !== expertId))
      fail(409, "CONFLICTING_ASSIGNMENT", "An existing assignment conflicts with the Client-approved Expert");
    if (!existing.length) {
      await db.query(`INSERT INTO request_expert_assignments(service_request_id,expert_id,assigned_by_user_id)
        VALUES($1,$2,$3) ON CONFLICT(service_request_id,expert_id) DO NOTHING`, [requestId, expertId, actor.id]);
      await writeAdminAudit(db, { actorUserId: actor.id, action: "assignment.confirmed", targetType: "service_request", targetId: requestId, summary: `Confirmed Client-approved Expert ${expertId}` });
    }
    await db.query("COMMIT");
    return { expertId, alreadyAssigned: existing.length > 0 };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }
};
