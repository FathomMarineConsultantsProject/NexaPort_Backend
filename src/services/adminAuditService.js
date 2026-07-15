export const writeAdminAudit = async (
  queryable,
  { actorUserId, action, targetType, targetId, summary = null, reason = null }
) => {
  await queryable.query(
    `
    INSERT INTO public.admin_audit_logs (
      actor_user_id, action, target_type, target_id, summary, reason
    ) VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      actorUserId || null,
      action,
      targetType,
      String(targetId),
      summary,
      reason,
    ]
  );
};
