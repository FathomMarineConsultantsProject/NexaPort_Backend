export const deleteServiceRequestById = async (client, requestId) => {
  const dependencies = await client.query(
    `SELECT
      (SELECT COUNT(*)::int FROM quotations WHERE service_request_id=$1) AS quotations,
      (SELECT COUNT(*)::int FROM request_expert_assignments WHERE service_request_id=$1) AS assignments`,
    [requestId]
  );
  const counts = dependencies.rows[0];
  if (Number(counts.quotations) > 0 || Number(counts.assignments) > 0) {
    const error = new Error("This service request has quotations or assignments and cannot be permanently deleted.");
    error.status = 409;
    throw error;
  }
  const deletedRequest = await client.query(
    `DELETE FROM public.service_requests WHERE id = $1 RETURNING id`,
    [requestId]
  );
  return { deleted: Boolean(deletedRequest.rows.length), dependencies: counts };
};
