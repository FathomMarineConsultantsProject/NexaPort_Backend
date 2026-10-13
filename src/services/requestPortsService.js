export const requestPortsSql = (alias = "sr") => `(SELECT COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT(
  'id',p.id,'port_name',p.port_name,'country',p.country,'unlocode',p.unlocode,'isPrimary',rp.is_primary)
  ORDER BY rp.position,p.id),'[]'::jsonb) FROM service_request_ports rp JOIN ports p ON p.id=rp.port_id WHERE rp.request_id=${alias}.id)`;

export const requestPortCollection = (row) => row.selected_ports?.length ? row.selected_ports
  : row.port_id ? [{ id: row.port_id, port_name: row.port_name || row.port_of_inspection, country: row.country, isPrimary: true }] : [];

const invalid = (message) => Object.assign(new Error(message), { status: 400 });
export const resolveSelectedRequestPorts = async (db, body, retainedIds = []) => {
  if (!Array.isArray(body.portIds) || body.portIds.length > 50) throw invalid("Select up to 50 canonical ports.");
  const ids = body.portIds.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) throw invalid("Select distinct valid canonical ports.");
  const primaryId = ids.length ? Number(body.primaryPortId ?? body.portId ?? ids[0]) : null;
  if (!ids.length && body.primaryPortId != null) throw invalid("An empty port selection cannot designate a primary port.");
  if (ids.length && !ids.includes(primaryId)) throw invalid("The primary port must be one of the selected ports.");
  if (!ids.length) return { ports: [], primary: null };
  const rows = (await db.query("SELECT id,port_name,country,unlocode FROM ports WHERE id=ANY($1::bigint[]) AND (is_active=TRUE OR id=ANY($2::bigint[])) FOR SHARE", [ids, retainedIds])).rows;
  if (rows.length !== ids.length) throw invalid("One or more selected ports are invalid or inactive.");
  const ports = ids.map((id) => ({ ...rows.find((p) => Number(p.id) === id), isPrimary: id === primaryId }));
  return { ports, primary: ports.find((p) => p.isPrimary) };
};

export const persistSelectedRequestPorts = async (db, requestId, ports) => {
  await db.query("DELETE FROM service_request_ports WHERE request_id=$1", [requestId]);
  for (const [position, port] of ports.entries()) await db.query(
    "INSERT INTO service_request_ports(request_id,port_id,position,is_primary) VALUES($1,$2,$3,$4)",
    [requestId, port.id, position, port.isPrimary]);
};

export const guardPrimaryPortScheduleChange = (request, primaryId, body) => {
  if (Number(request.port_id || 0) === Number(primaryId || 0)) return;
  if ((request.terminal_name || request.eta) && body.confirmPrimaryPortChange !== true)
    throw invalid("Confirm the primary-port change before replacing its Terminal and ETA.");
};
