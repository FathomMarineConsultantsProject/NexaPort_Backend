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

export const createProposalSentNotification = async (
  queryable,
  { requestId, recipientUserId, revisionNumber, clientTotalUsd, vesselName, serviceName }
) => {
  const title = "Commercial proposal ready for review";
  const message = `A commercial proposal (Revision #${revisionNumber}) for ${serviceName || "inspection"} on ${vesselName || "vessel"} ($${Number(clientTotalUsd || 0).toLocaleString()}) is ready for your review.`;
  const payload = JSON.stringify({
    request_id: requestId,
    revision_number: revisionNumber,
    client_total_usd: clientTotalUsd,
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
    VALUES ($1, 'commercial_proposal_sent', 'commercial_proposal', $2, $3, $4, $5::jsonb)
    ON CONFLICT (recipient_user_id, type, entity_type, entity_id)
    DO NOTHING
    RETURNING id
    `,
    [recipientUserId, String(requestId), title, message, payload]
  );

  return result.rowCount;
};

export const createProposalApprovedNotification = async (
  queryable,
  { requestId, proposalId, clientTotalUsd, consultantUserId, vesselName }
) => {
  const payload = JSON.stringify({
    request_id: requestId,
    proposal_id: proposalId,
    client_total_usd: clientTotalUsd,
  });

  // 1. Notify Super Admins
  await queryable.query(
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
      'commercial_proposal_approved',
      'commercial_proposal',
      $1,
      'Commercial proposal approved by Client',
      $2,
      $3::jsonb
    FROM public.users u
    WHERE u.role_id = 1
      AND u.is_active = TRUE
    ON CONFLICT (recipient_user_id, type, entity_type, entity_id)
    DO NOTHING
    `,
    [
      String(proposalId),
      `Client approved commercial proposal for ${vesselName || "request"} ($${Number(clientTotalUsd || 0).toLocaleString()}). Surveyor assignment confirmed.`,
      payload,
    ]
  );

  // 2. Notify the accepted Consultant (if active)
  if (consultantUserId) {
    await queryable.query(
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
      VALUES ($1, 'commercial_proposal_approved', 'commercial_proposal', $2, $3, $4, $5::jsonb)
      ON CONFLICT (recipient_user_id, type, entity_type, entity_id)
      DO NOTHING
      `,
      [
        consultantUserId,
        String(proposalId),
        'Your quotation was accepted',
        `Your quotation for ${vesselName || "request"} has been accepted and confirmed for assignment.`,
        payload,
      ]
    );
  }
};

export const createProposalRejectedNotification = async (
  queryable,
  { requestId, proposalId, revisionNumber, rejectionReason, vesselName }
) => {
  const payload = JSON.stringify({
    request_id: requestId,
    proposal_id: proposalId,
    revision_number: revisionNumber,
    rejection_reason: rejectionReason,
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
    SELECT
      u.id,
      'commercial_proposal_rejected',
      'commercial_proposal',
      $1,
      'Commercial proposal declined by Client',
      $2,
      $3::jsonb
    FROM public.users u
    WHERE u.role_id = 1
      AND u.is_active = TRUE
    ON CONFLICT (recipient_user_id, type, entity_type, entity_id)
    DO NOTHING
    `,
    [
      String(proposalId),
      `Client declined proposal (Revision #${revisionNumber}) for ${vesselName || "request"}. Reason: ${String(rejectionReason || "").slice(0, 100)}`,
      payload,
    ]
  );

  return result.rowCount;
};

export const createInspectionWorkflowNotification = async (
  queryable,
  { actorUserId, requestId, workflowId, type, title, message, payload = {} }
) => {
  const result = await queryable.query(
    `
    INSERT INTO public.admin_notifications (
      recipient_user_id, type, entity_type, entity_id, title, message, payload
    )
    SELECT u.id, $1, 'inspection_workflow', $2, $3, $4, $5::jsonb
    FROM public.users u
    WHERE u.role_id=1 AND u.is_active=TRUE AND u.id<>$6
    ON CONFLICT (recipient_user_id, type, entity_type, entity_id) DO NOTHING
    RETURNING id
    `,
    [type, String(workflowId), title, message, JSON.stringify({ request_id: requestId, ...payload }), actorUserId]
  );
  return result.rowCount;
};
