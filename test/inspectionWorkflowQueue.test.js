import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../src/config/db.js";
import { listInspectionWorkflows } from "../src/services/inspectionWorkflowService.js";

test("workflow queue returns approved requests with optional relationships absent or present", async () => {
  const originalQuery = pool.query;
  let capturedSql = "";
  pool.query = async (sql) => {
    capturedSql = sql;
    return { rows: [
      { request_id: 1, title: "No workflow", client_name: "A", vessel_name: null, service: "Survey", port_name: null, request_status: "open", moderation_status: "approved", quotations_awaiting_review: 0, workflow_id: null, current_stage: "overview", updated_at: new Date() },
      { request_id: 2, title: "Existing workflow", client_name: "B", vessel_name: "MV Test", service: "Inspection", port_name: "Kochi", request_status: "open", moderation_status: "approved", quotations_awaiting_review: 2, workflow_id: 50, current_stage: "quote", operational_expert_id: null, updated_at: new Date() },
      { request_id: 3, title: "Assigned", client_name: null, vessel_name: null, service: "Audit", port_name: null, request_status: "assigned", moderation_status: "approved", quotations_awaiting_review: 0, workflow_id: 51, current_stage: "surveyor", operational_expert_id: 8, accepted_expert_name: "Consultant One", updated_at: new Date() },
    ] };
  };
  try {
    const result = await listInspectionWorkflows();
    assert.equal(result.length, 3);
    assert.equal(result[0].workflowId, null);
    assert.equal(result[0].vesselName, null);
    assert.equal(result[0].quotationsAwaitingReview, 0);
    assert.equal(result[1].quotationsAwaitingReview, 2);
    assert.deepEqual(result[2].acceptedExpert, { id: 8, name: "Consultant One" });
    assert.match(capturedSql, /FROM service_requests sr/);
    assert.match(capturedSql, /LEFT JOIN inspection_workflows/);
    assert.match(capturedSql, /LEFT JOIN quotations accepted_q/);
    assert.match(capturedSql, /LEFT JOIN LATERAL/);
    assert.match(capturedSql, /operational_expert\.full_name AS accepted_expert_name/);
    assert.doesNotMatch(capturedSql, /aq\.expert_name/);
    assert.doesNotMatch(capturedSql, /JOIN inspection_invoices/);
  } finally {
    pool.query = originalQuery;
  }
});
