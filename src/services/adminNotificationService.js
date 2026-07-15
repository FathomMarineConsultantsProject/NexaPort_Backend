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

export const createServiceRequestApprovedNotifications = async (
  queryable,
  { requestId, inspectionType, vesselType, inspectionDate, portOfInspection }
) => {
  const message = `A new ${inspectionType} request is available at ${portOfInspection} for ${inspectionDate}.`;
  const payload = JSON.stringify({
    request_id: requestId,
    inspection_type: inspectionType,
    vessel_type: vesselType,
    inspection_date: inspectionDate,
    port_of_inspection: portOfInspection,
  });

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
    SELECT DISTINCT
      u.id,
      'service_request_approved',
      'service_request',
      $1,
      'New inspection request available',
      $2,
      $3::jsonb
    FROM public.users u
    JOIN public.experts e ON e.user_id = u.id
    WHERE u.role_id = 2
      AND u.is_active = TRUE
    ON CONFLICT (recipient_user_id, type, entity_type, entity_id)
    DO NOTHING
    RETURNING id
    `,
    [String(requestId), message, payload]
  );

  return result.rowCount;
};
