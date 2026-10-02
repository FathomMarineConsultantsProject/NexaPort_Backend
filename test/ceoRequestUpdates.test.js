import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { pool } from "../src/config/db.js";
import { createServiceRequest, updateServiceRequest, approveServiceRequest, getServiceRequestById } from "../src/controllers/serviceRequestController.js";
import { normalizeRequestParticulars, prefillPortAgent } from "../src/services/requestParticularsService.js";
import { advanceSurveyorToPreparation } from "../src/services/inspectionWorkflowPhase2Service.js";
import { createServiceRequestApprovedNotifications } from "../src/services/adminNotificationService.js";

const response = () => ({ statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });
const body = { serviceType: "Audit", serviceCategory: "ISM", title: "Test", scopeOfWork: "Scope" };
const columns = (sql, values) => Object.fromEntries(sql.match(/INSERT INTO service_requests\s*\(([\s\S]*?)\)\s*VALUES/)[1].split(",").map((column, index) => [column.trim(), values[index]]));

async function withClient(query, work) {
  const original = pool.connect;
  pool.connect = async () => ({ query, release() {} });
  try { return await work(); } finally { pool.connect = original; }
}

async function create(input, company = "Registered Marine Ltd") {
  let stored; const calls = []; const res = response();
  await withClient(async (sql, values = []) => {
    calls.push(sql);
    if (/SELECT cc.legal_name/.test(sql)) return { rows: company ? [{ legal_name: company }] : [] };
    if (/SELECT id, port_name, country FROM ports/.test(sql)) return { rows: [{ id: 5, port_name: "Singapore", country: "Singapore" }] };
    if (/INSERT INTO service_requests/.test(sql)) { stored = columns(sql, values); return { rows: [{ id: 9, ...stored }] }; }
    return { rows: [] };
  }, () => createServiceRequest({ body: { ...body, ...input }, user: { id: 3, role_id: 3, full_name: "Personal Name" } }, res));
  return { stored, calls, res };
}

test("new Client company snapshot comes from registered company, ignoring arbitrary personal input", async () => {
  const { stored, res } = await create({ requesterName: "Personal Override" });
  assert.equal(res.statusCode, 201);
  assert.equal(stored.requester_name, "Registered Marine Ltd");
  assert.equal(stored.requester_user_id, 3);
  assert.equal(res.body.data.companyName, "Registered Marine Ltd");
});

test("missing company never falls back to personal identity", async () => {
  const { stored } = await create({ requesterName: "Personal Override" }, null);
  assert.equal(stored.requester_name, null);
});

test("canonical Port overrides supplied name/country; terminal and agents persist trimmed", async () => {
  const { stored, res } = await create({ portId: 5, portName: "Spoofed", country: "Wrong", terminalName: " Terminal A ", agentCompanyName: " Agent Ltd ", agentContactName: " Contact ", agentEmail: " agent@example.com ", agentPhone: " +65 12345678 " });
  assert.equal(stored.port_id, 5);
  assert.equal(stored.port_name, "Singapore");
  assert.equal(stored.country, "Singapore");
  assert.equal(stored.terminal_name, "Terminal A");
  assert.equal(res.body.data.agentDetails.companyName, "Agent Ltd");
  assert.equal(stored.agent_contact_name, "Contact");
  assert.equal(stored.agent_email, "agent@example.com");
  assert.equal(stored.agent_phone, "+65 12345678");
});

test("optional contacts are nullable; pending submission never creates Consultant notifications", async () => {
  const { stored, calls } = await create({});
  assert.equal(stored.agent_email, null);
  assert.equal(stored.terminal_name, null);
  assert.equal(stored.moderation_status, "pending");
  assert.ok(calls.every((sql) => !/admin_notifications/.test(sql)));
});

test("legacy country/location/certification payload remains accepted", async () => {
  const { stored } = await create({ country: "Legacy country", locationSummary: "Legacy location", requiredCertification: "Legacy certification" });
  assert.equal(stored.country, "Legacy country");
  assert.equal(stored.location_summary, "Legacy location");
  assert.equal(stored.required_certification, "Legacy certification");
});

test("legacy free-text Port and Country still resolve through existing helper", async () => {
  const original = pool.query;
  pool.query = async () => ({ rows: [{ id: 6, port_name: "Legacy Port", country: "Legacy Country" }] });
  try { const { stored } = await create({ portName: "Legacy Port", country: "Legacy Country" }); assert.equal(stored.port_id, 6); }
  finally { pool.query = original; }
});

test("invalid agent contact and length fail field validation", async () => {
  for (const input of [{ agentEmail: "bad" }, { agentPhone: "abc" }, { agentCompanyName: "x".repeat(241) }, { terminalName: {} }]) {
    const { res, stored } = await create(input);
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.field_errors[Object.keys(input)[0]]);
    assert.equal(stored, undefined);
  }
  assert.deepEqual(normalizeRequestParticulars({ agentEmail: " " }).values, { agentEmail: null });
});

test("PUT persists new fields and never updates omitted hidden legacy columns", async () => {
  let update; const res = response();
  await withClient(async (sql, values = []) => {
    if (/FOR UPDATE OF sr/.test(sql)) return { rows: [{ id: 9, requester_user_id: 3, status: "open", moderation_status: "pending", country: "Historical", location_summary: "Old", required_certification: "Old certificate" }] };
    if (/UPDATE service_requests/.test(sql)) { update = { sql, values }; return { rows: [{ id: 9, country: "Historical", required_certification: "Old certificate" }] }; }
    return { rows: [] };
  }, () => updateServiceRequest({ params: { id: 9 }, user: { id: 3, role_id: 3 }, body: { terminalName: " Terminal B ", agentEmail: " contact@example.com " } }, res));
  assert.equal(res.statusCode, 200);
  assert.match(update.sql, /terminal_name =/);
  assert.match(update.sql, /agent_email =/);
  assert.doesNotMatch(update.sql, /country =|location_summary =|required_certification =|requester_name =/);
  assert.ok(update.values.includes("Terminal B"));
  assert.equal(res.body.data.requiredCertification, "Old certificate");
});

test("PUT canonical Port derives name/country and rejects unavailable IDs", async () => {
  for (const found of [true, false]) {
    let update; const res = response();
    await withClient(async (sql, values = []) => {
      if (/FOR UPDATE OF sr/.test(sql)) return { rows: [{ id: 9, requester_user_id: 3, status: "open", moderation_status: "pending" }] };
      if (/SELECT id, port_name, country FROM ports/.test(sql)) return { rows: found ? [{ id: 5, port_name: "Singapore", country: "Singapore" }] : [] };
      if (/UPDATE service_requests/.test(sql)) { update = { sql, values }; return { rows: [{ id: 9 }] }; }
      return { rows: [] };
    }, () => updateServiceRequest({ params: { id: 9 }, user: { id: 3, role_id: 3 }, body: { portId: 5, country: "Spoof" } }, res));
    assert.equal(res.statusCode, found ? 200 : 400);
    if (found) { assert.match(update.sql, /port_id =/); assert.ok(update.values.includes("Singapore")); assert.ok(!update.values.includes("Spoof")); }
  }
});

test("approved Consultant serializer exposes Terminal but no agent or company contacts", async () => {
  const original = pool.query; pool.query = async () => ({ rows: [{ id: 9, terminal_name: "A", agent_email: "private@example.com", requester_name: "Private" }] });
  try {
    const res = response(); await getServiceRequestById({ params: { id: 9 }, user: { id: 2, role_id: 2 } }, res);
    assert.equal(res.body.data.terminalName, "A");
    assert.equal(res.body.data.agentDetails, undefined);
    assert.equal(res.body.data.requesterName, undefined);
  } finally { pool.query = original; }
});

test("preparation prefills only empty agent values and keeps saved manual contacts", async () => {
  const request = { agent_company_name: "Request company", agent_contact_name: "Request contact", agent_email: "request@example.com" };
  const prepared = { portAgent: { company: "Manual company", name: "", phone: "+65 12345678" }, notes: "Keep" };
  const filled = prefillPortAgent(prepared, request);
  assert.equal(filled.portAgent.company, "Manual company");
  assert.equal(filled.portAgent.name, "Request contact");
  assert.equal(filled.portAgent.email, "request@example.com");
  assert.equal(filled.portAgent.phone, "+65 12345678");
  assert.equal(prepared.portAgent.name, "");
  let persisted;
  await withClient(async (sql, values = []) => {
    if (/FOR UPDATE OF iw,sr/.test(sql)) return { rows: [{ id: 1, current_stage: "surveyor", accepted_quotation_id: 2, accepted_expert_id: 3, preparation_data: prepared, ...request }] };
    if (/UPDATE inspection_workflows/.test(sql)) persisted = JSON.parse(values[1]);
    return { rows: [] };
  }, () => advanceSurveyorToPreparation({ requestId: 9, actorUserId: 1 }));
  assert.deepEqual(persisted, filled);
});

test("approval hook creates notifications transactionally; repeated approval stops before insert", async () => {
  for (const moderation_status of ["pending", "approved"]) {
    const calls = [], res = response();
    await withClient(async (sql) => {
      calls.push(sql);
      if (/SELECT \* FROM service_requests/.test(sql)) return { rows: [{ id: 9, moderation_status, title: "Title", scope_of_work: "Scope", service_type: "Audit", service_category: "ISM", vessel_type: "Bulk Carrier", required_by: "2026-10-10", port_name: "Singapore" }] };
      return { rows: [{ id: 9 }], rowCount: 1 };
    }, () => approveServiceRequest({ params: { id: 9 }, user: { id: 1, role_id: 1 } }, res));
    assert.equal(res.statusCode, moderation_status === "pending" ? 200 : 409);
    assert.equal(calls.some((sql) => /INSERT INTO public.admin_notifications/.test(sql)), moderation_status === "pending");
    if (moderation_status === "pending") assert.ok(calls.findIndex((sql) => /admin_notifications/.test(sql)) < calls.indexOf("COMMIT"));
  }
});

test("bulk notification SQL includes all active primary/membership Consultants and retains lifetime conflict key", async () => {
  let captured;
  await createServiceRequestApprovedNotifications({ query: async (sql, values) => { captured = { sql, values }; return { rowCount: 2 }; } }, { requestId: 9, inspectionType: "Pre-Purchase Inspections", portOfInspection: "Singapore" });
  assert.match(captured.sql, /u.is_active = TRUE\s+AND \(u.role_id = 2 OR EXISTS/);
  assert.match(captured.sql, /ur.user_id = u.id AND ur.role_id = 2/);
  assert.doesNotMatch(captured.sql, /JOIN public.experts|capabilit|specialty|country|expert_ports/);
  assert.match(captured.sql, /ON CONFLICT \(recipient_user_id, type, entity_type, entity_id\)\s+DO NOTHING/);
  assert.equal(captured.values[1], "A new Pre-Purchase Inspections request is available at Singapore.");
  // Primary-only Clients/Providers are excluded by the role predicate; inactive Consultants by the active predicate.
  const eligible = (user) => user.active && (user.role === 2 || user.roles.includes(2));
  assert.deepEqual([{ id: 1, active: true, role: 2, roles: [] }, { id: 2, active: true, role: 3, roles: [2] }, { id: 3, active: true, role: 3, roles: [] }, { id: 4, active: true, role: 4, roles: [] }, { id: 5, active: false, role: 2, roles: [] }].filter(eligible).map((user) => user.id), [1, 2]);
});

test("local CEO migration only adds five nullable fields", async () => {
  const sql = await readFile(new URL("../sql/service_request_ceo_updates_001.sql", import.meta.url), "utf8");
  assert.equal((sql.match(/ADD COLUMN IF NOT EXISTS/g) || []).length, 5);
  assert.doesNotMatch(sql, /DROP|NOT NULL|CREATE TABLE|INSERT|UPDATE /);
});
