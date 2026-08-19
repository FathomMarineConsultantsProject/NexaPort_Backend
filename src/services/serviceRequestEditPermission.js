const EDITABLE_MODERATION_STATUSES = new Set(["pending", "rejected", "approved"]);
const WORKFLOW_LOCK_STAGES = new Set([
  "surveyor", "preparation", "checklist", "report", "review",
  "report_confirmation", "inspection_completed", "invoice_submitted",
  "invoice_approved", "invoice_paid",
]);

const denied = (status, code, message) => ({ allowed: false, status, code, message });

export const getServiceRequestEditPermission = ({ request, roleId, userId }) => {
  const role = Number(roleId);
  if (![1, 3].includes(role)) {
    return denied(403, "REQUEST_EDIT_ROLE_FORBIDDEN", "Consultants and Providers cannot edit Client service requests.");
  }
  if (role === 3 && Number(request.requester_user_id) !== Number(userId)) {
    return denied(403, "REQUEST_EDIT_NOT_OWNER", "You can only edit your own service requests.");
  }

  const requestStatus = String(request.status || "").toLowerCase();
  const workflowStage = String(request.workflow_stage || "").toLowerCase();
  const downstreamLocked = Boolean(
    request.accepted_quotation_id || request.accepted_expert_id || request.has_accepted_quotation ||
    request.has_assignment || ["assigned", "in progress", "in_progress", "completed"].includes(requestStatus) ||
    WORKFLOW_LOCK_STAGES.has(workflowStage)
  );
  if (downstreamLocked) {
    return denied(409, "REQUEST_EDIT_WORKFLOW_LOCKED", "This request is already in the inspection workflow. Core request details are locked to protect the accepted quotation and inspection record.");
  }

  const moderationStatus = String(request.moderation_status || "pending").toLowerCase();
  if (!EDITABLE_MODERATION_STATUSES.has(moderationStatus)) {
    return denied(409, "REQUEST_EDIT_STATUS_LOCKED", "This request is not in an editable moderation state.");
  }
  if (role === 3 && moderationStatus === "approved" && Number(request.quotation_count || 0) > 0) {
    return denied(409, "REQUEST_EDIT_QUOTATIONS_EXIST", "This request cannot be edited because quotations have already been submitted. Please contact Nexaport.");
  }
  return { allowed: true, status: 200, code: null, message: null };
};
