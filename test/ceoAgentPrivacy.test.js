import assert from "node:assert/strict";
import test from "node:test";
import { agentDetailsForRole, clientAgentReplacement, consultantHasConfirmedAgentAccess } from "../src/services/agentDisclosureService.js";

const row = { agent_company_name: "Port Co", agent_contact_name: "A. Contact", agent_email: "a@example.com", agent_phone: "+65 12345678" };

test("agent fields are Admin-only until a confirmed assignment, then name-only", () => {
  assert.deepEqual(agentDetailsForRole(row, 1), { companyName: "Port Co", contactName: "A. Contact", email: "a@example.com", phone: "+65 12345678" });
  for (const role of [2, 3, 4]) assert.equal(agentDetailsForRole(row, role), undefined);
  assert.deepEqual(agentDetailsForRole(row, 2, true), { contactName: "A. Contact" });
  assert.equal(agentDetailsForRole({ ...row, agent_contact_name: null }, 2, true), undefined);
});

test("empty Client replacement inputs cannot clear saved values", () => {
  assert.deepEqual(clientAgentReplacement({ title: "Changed", agentEmail: "", agentPhone: "  ", agentContactName: "New" }),
    { title: "Changed", agentContactName: "New" });
});

test("Consultant gate is request- and user-scoped to Client approval and assignment", async () => {
  const calls = [];
  const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rowCount: values[0] === 9 && values[1] === 2 ? 1 : 0 }; } };
  assert.equal(await consultantHasConfirmedAgentAccess(db, 9, 2), true);
  assert.equal(await consultantHasConfirmedAgentAccess(db, 10, 2), false);
  assert.equal(await consultantHasConfirmedAgentAccess(db, 9, 3), false);
  assert.match(calls[0].sql, /cp.status='approved'/);
  assert.match(calls[0].sql, /request_expert_assignments/);
  assert.match(calls[0].sql, /cp.decided_by_user_id=sr.requester_user_id/);
});
