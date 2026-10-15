import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { agentDetailsForRole } from "../src/services/agentDisclosureService.js";

test("agent disclosure remains limited by role and confirmed assignment", () => {
  const row = {
    agent_company_name: "Harbour Agency",
    agent_contact_name: "Port Contact",
    agent_email: "agent@example.test",
    agent_phone: "+123456789",
  };
  assert.deepEqual(agentDetailsForRole(row, 1), {
    companyName: row.agent_company_name,
    contactName: row.agent_contact_name,
    email: row.agent_email,
    phone: row.agent_phone,
  });
  assert.deepEqual(agentDetailsForRole(row, 2, true), { contactName: row.agent_contact_name });
  assert.equal(agentDetailsForRole(row, 2, false), undefined);
  assert.equal(agentDetailsForRole(row, 3), undefined);
  assert.equal(agentDetailsForRole(row, 4), undefined);
});

test("submitter account lookup is gated to Super Admin request details", async () => {
  const source = await readFile(new URL("../src/controllers/serviceRequestController.js", import.meta.url), "utf8");
  assert.match(source, /if \(Number\(req\.user\.role_id\) === 1\) \{\s*const submitter = requestRow\.requester_user_id/);
  assert.match(source, /SELECT id, full_name, email FROM users WHERE id=\$1/);
  assert.match(source, /requestData\.submittedBy = submitter/);
  assert.match(source, /: \{ source: "legacy" \}/);
});
