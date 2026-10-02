export const REQUEST_PARTICULAR_FIELDS = Object.freeze({
  terminalName: ["terminal_name", 240],
  agentCompanyName: ["agent_company_name", 240],
  agentContactName: ["agent_contact_name", 160],
  agentEmail: ["agent_email", 254],
  agentPhone: ["agent_phone", 30],
});

export function normalizeRequestParticulars(body = {}) {
  const values = {}, fieldErrors = {};
  for (const [key, [, max]] of Object.entries(REQUEST_PARTICULAR_FIELDS)) {
    if (!Object.hasOwn(body, key)) continue;
    if (body[key] != null && typeof body[key] !== "string") {
      fieldErrors[key] = "Must be text.";
      continue;
    }
    const value = (body[key] || "").trim();
    if (value.length > max) fieldErrors[key] = `Must be ${max} characters or fewer.`;
    values[key] = value || null;
  }
  if (values.agentEmail && !/^\S+@\S+\.\S+$/.test(values.agentEmail)) fieldErrors.agentEmail = "Enter a valid email address.";
  if (values.agentPhone && !/^[+()0-9 .-]{5,30}$/.test(values.agentPhone)) fieldErrors.agentPhone = "Enter a valid phone number.";
  return { values, fieldErrors };
}

export async function resolveRequestCompany(queryable, userId) {
  const result = await queryable.query(`SELECT cc.legal_name FROM client_profiles cp
    JOIN client_companies cc ON cc.client_profile_id = cp.id WHERE cp.user_id = $1 LIMIT 1`, [userId]);
  return result.rows[0]?.legal_name?.trim() || null;
}

export async function resolveRequestPort(queryable, portId) {
  const id = Number(portId);
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error("Select a valid Port."), { status: 400 });
  const result = await queryable.query("SELECT id, port_name, country FROM ports WHERE id = $1 AND is_active = TRUE", [id]);
  if (!result.rows[0]) throw Object.assign(new Error("The selected Port is unavailable."), { status: 400 });
  return result.rows[0];
}

export function prefillPortAgent(preparation = {}, request = {}) {
  const portAgent = { ...preparation.portAgent };
  for (const [key, column] of Object.entries({ company: "agent_company_name", name: "agent_contact_name", email: "agent_email", phone: "agent_phone" })) {
    if (!String(portAgent[key] ?? "").trim() && request[column]) portAgent[key] = request[column];
  }
  return { ...preparation, portAgent };
}
