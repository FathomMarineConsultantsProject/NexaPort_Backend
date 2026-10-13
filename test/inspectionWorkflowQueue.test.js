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
    assert.match(capturedSql, /SELECT ii\.status FROM inspection_invoices/);
    assert.doesNotMatch(capturedSql, /aq\.expert_name/);
    assert.doesNotMatch(capturedSql, /JOIN inspection_invoices/);
  } finally {
    pool.query = originalQuery;
  }
});

test("queue totals count quotation threads across review, revision, approval and historical states", async (t) => {
  const originalQuery = pool.query;
  const cases = [
    { name: "no quotations", quotes: [], total: 0, review: 0 },
    { name: "one submitted quotation", quotes: [{ status: "submitted", internal: "awaiting_review" }], total: 1, review: 1 },
    { name: "internal revision request", quotes: [{ status: "pending", internal: "revision_requested" }], total: 1, review: 0 },
    { name: "several revisions of one thread", quotes: [{ status: "submitted", internal: "awaiting_review", revisions: 5 }], total: 1, review: 1 },
    { name: "internally approved quotation", quotes: [{ status: "pending", internal: "approved" }], total: 1, review: 0 },
    { name: "Client-accepted quotation", quotes: [{ status: "accepted", internal: "approved" }], total: 1, review: 0 },
    { name: "historical rejected quotations", quotes: [{ status: "rejected", internal: "rejected" }, { status: "rejected", internal: "approved" }], total: 2, review: 0 },
    { name: "Confirm with selected approved quotation and rejected alternative", stage: "confirm", quotes: [{ status: "pending", internal: "approved" }, { status: "rejected", internal: "rejected" }], total: 2, review: 0 },
  ];
  try {
    for (const scenario of cases) await t.test(scenario.name, async () => {
      let queries = 0;
      pool.query = async (sql) => {
        queries++;
        const aggregate = sql.slice(sql.indexOf("SELECT COUNT(*)::int AS total"), sql.indexOf(") quotation_counts ON TRUE"));
        assert.match(aggregate, /^SELECT COUNT\(\*\)::int AS total,/);
        assert.match(aggregate, /COUNT\(\*\) FILTER \(WHERE q.status IN \('pending','submitted'\)/);
        assert.match(aggregate, /FROM quotations q WHERE q.service_request_id=sr.id\s*$/);
        assert.doesNotMatch(aggregate, /JOIN|quotation_revisions|commercial_proposals/);
        return { rows: [{ request_id: 34, current_stage: scenario.stage || "quote", quotations_total: scenario.quotes.length,
          quotations_awaiting_review: scenario.quotes.filter((q) => ["pending", "submitted"].includes(q.status) && q.internal === "awaiting_review").length,
        }] };
      };
      const [row] = await listInspectionWorkflows();
      assert.equal(row.quotationsTotal, scenario.total);
      assert.equal(row.quotationsAwaitingReview, scenario.review);
      assert.equal(row.currentStage, scenario.stage || "quote");
      assert.equal(queries, 1, "Listing must use one database query");
    });
  } finally { pool.query = originalQuery; }
});
