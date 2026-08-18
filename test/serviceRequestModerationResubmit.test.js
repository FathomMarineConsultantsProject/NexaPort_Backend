import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../src/config/db.js";
import {
  updateServiceRequest,
  rejectServiceRequest,
  approveServiceRequest,
} from "../src/controllers/serviceRequestController.js";

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test("Client cannot edit pending request (returns 409 REQUEST_UNDER_REVIEW)", async () => {
  const originalConnect = pool.connect;
  pool.connect = async () => ({
    async query(sql) {
      if (/FOR UPDATE/.test(sql)) {
        return { rows: [{ id: 10, requester_user_id: 3, moderation_status: "pending" }] };
      }
      return { rows: [] };
    },
    release() {},
  });
  const res = response();
  try {
    await updateServiceRequest({
      params: { id: 10 },
      body: { title: "Updated Title" },
      user: { id: 3, role_id: 3 },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "REQUEST_UNDER_REVIEW");
  } finally {
    pool.connect = originalConnect;
  }
});

test("Client can edit and resubmit rejected request", async () => {
  const originalConnect = pool.connect;
  const executedQueries = [];
  pool.connect = async () => ({
    async query(sql, values) {
      executedQueries.push({ sql, values });
      if (/FOR UPDATE/.test(sql)) {
        return { rows: [{
          id: 12,
          requester_user_id: 3,
          moderation_status: "rejected",
          rejection_reason: "Missing IMO",
          client_budget_usd: 1000,
          approved_budget_usd: 1000,
          admin_budget_adjustment_type: "percentage",
          admin_budget_adjustment_mode: "markup",
          admin_budget_adjustment_value: 10,
        }] };
      }
      if (/UPDATE service_requests SET/.test(sql)) {
        return { rows: [{
          id: 12,
          title: "Revised Title",
          scope_of_work: "Revised Scope",
          moderation_status: "pending",
          rejection_reason: null,
          client_budget_usd: 1200,
          approved_budget_usd: 1200,
          admin_budget_adjustment_type: "none",
          admin_budget_adjustment_mode: "none",
          admin_budget_adjustment_value: 0,
        }] };
      }
      return { rows: [] };
    },
    release() {},
  });
  const res = response();
  try {
    await updateServiceRequest({
      params: { id: 12 },
      body: { title: "Revised Title", budgetUsd: 1200 },
      user: { id: 3, role_id: 3 },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, "Request resubmitted for review");
    assert.equal(res.body.data.moderationStatus, "pending");
    assert.equal(res.body.data.rejectionReason, null);
    assert.equal(res.body.data.clientBudgetUsd, 1200);

    const updateQuery = executedQueries.find((q) => /UPDATE service_requests SET/.test(q.sql));
    assert.match(updateQuery.sql, /moderation_status =/);
    assert.match(updateQuery.sql, /rejection_reason = NULL/);
  } finally {
    pool.connect = originalConnect;
  }
});

test("Admin rejection requires valid reason", async () => {
  const res = response();
  await rejectServiceRequest({
    params: { id: 15 },
    body: { rejectionReason: "   " },
    user: { id: 1, role_id: 1 },
  }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "A rejection reason is required.");
});

test("Admin approval validates all 6 required fields", async () => {
  const originalConnect = pool.connect;
  pool.connect = async () => ({
    async query(sql) {
      if (/FOR UPDATE/.test(sql)) {
        return { rows: [{
          id: 20,
          title: "", // Missing
          scope_of_work: "Scope",
          service_type: "Inspection",
          vessel_type: "", // Missing
          required_by: null, // Missing
          port_name: "Port",
        }] };
      }
      return { rows: [] };
    },
    release() {},
  });
  const res = response();
  try {
    await approveServiceRequest({
      params: { id: 20 },
      user: { id: 1, role_id: 1 },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "REQUEST_APPROVAL_FIELDS_REQUIRED");
    assert.deepEqual(res.body.missingFields, ["Title", "Vessel Type", "Required Inspection Date"]);
  } finally {
    pool.connect = originalConnect;
  }
});
