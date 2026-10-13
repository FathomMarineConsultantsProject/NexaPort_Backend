// Keep marketplace visibility identical for direct request IDs and shared locators.
export const consultantMayViewRequest = async (queryable, request, userId) => {
  if (request?.moderation_status !== "approved") return false;
  const status = String(request.status || "").toLowerCase();
  if (["open", "pending", "active"].includes(status)) return true;
  if (!["assigned", "completed"].includes(status)) return false;
  const assigned = await queryable.query(
    `SELECT 1 FROM experts e WHERE e.user_id=$1 AND
      (e.id=$2 OR EXISTS (SELECT 1 FROM request_expert_assignments rea
        WHERE rea.service_request_id=$3 AND rea.expert_id=e.id)) LIMIT 1`,
    [userId, request.accepted_expert_id, request.id]
  );
  return assigned.rowCount > 0;
};

export const userMayViewRequest = async (queryable, request, user) => {
  if (!request) return false;
  const role = Number(user.role_id);
  if (role === 1) return true;
  if (role === 3) return Number(request.requester_user_id) === Number(user.id);
  if (role === 2) return consultantMayViewRequest(queryable, request, user.id);
  return false;
};
