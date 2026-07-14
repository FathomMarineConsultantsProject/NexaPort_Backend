export const createRegistrationNotifications = async (
  queryable,
  { type, entityType, entityId, title, message = null, payload = {} }
) => {
  const result = await queryable.query(
    `
    INSERT INTO public.admin_notifications (
      recipient_user_id,
      type,
      entity_type,
      entity_id,
      title,
      message,
      payload
    )
    SELECT
      u.id,
      $1,
      $2,
      $3,
      $4,
      $5,
      $6::jsonb
    FROM public.users u
    WHERE u.role_id = 1
      AND u.is_active = TRUE
    ON CONFLICT (recipient_user_id, type, entity_type, entity_id)
    DO NOTHING
    RETURNING id
    `,
    [
      type,
      entityType,
      String(entityId),
      title,
      message,
      JSON.stringify(payload),
    ]
  );

  return result.rowCount;
};
