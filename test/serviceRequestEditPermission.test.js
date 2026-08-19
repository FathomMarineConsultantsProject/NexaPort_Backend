import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../src/config/db.js";
import { updateServiceRequest } from "../src/controllers/serviceRequestController.js";
import { getServiceRequestEditPermission } from "../src/services/serviceRequestEditPermission.js";

const base = { id: 7, requester_user_id: 30, moderation_status: "approved", status: "open", quotation_count: 0 };
const permission = (request, roleId, userId = 30) => getServiceRequestEditPermission({ request: { ...base, ...request }, roleId, userId });

test("Client edit permission matrix enforces ownership, quotations, and downstream lock", () => {
  assert.equal(permission({ moderation_status: "pending" }, 3).allowed, true);
  assert.equal(permission({ moderation_status: "rejected" }, 3).allowed, true);
  assert.equal(permission({ moderation_status: "approved", quotation_count: 0 }, 3).allowed, true);
  assert.equal(permission({ quotation_count: 1 }, 3).code, "REQUEST_EDIT_QUOTATIONS_EXIST");
  assert.equal(permission({ accepted_quotation_id: 8 }, 3).code, "REQUEST_EDIT_WORKFLOW_LOCKED");
  assert.equal(permission({ status: "assigned" }, 3).code, "REQUEST_EDIT_WORKFLOW_LOCKED");
  assert.equal(permission({}, 3, 31).code, "REQUEST_EDIT_NOT_OWNER");
});

test("Super Admin can edit moderated requests before acceptance, including requests with pending quotations", () => {
  for (const moderation_status of ["pending", "rejected", "approved"]) {
    assert.equal(permission({ moderation_status }, 1, 1).allowed, true);
  }
  assert.equal(permission({ quotation_count: 2 }, 1, 1).allowed, true);
  assert.equal(permission({ accepted_quotation_id: 9 }, 1, 1).code, "REQUEST_EDIT_WORKFLOW_LOCKED");
  assert.equal(permission({ workflow_stage: "surveyor" }, 1, 1).code, "REQUEST_EDIT_WORKFLOW_LOCKED");
});

test("Consultant and Provider edits are forbidden", () => {
  assert.equal(permission({}, 2, 2).code, "REQUEST_EDIT_ROLE_FORBIDDEN");
  assert.equal(permission({}, 4, 4).code, "REQUEST_EDIT_ROLE_FORBIDDEN");
});

const response = () => ({
  statusCode: 200, body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test("Client edit of approved request with zero quotations resets budget decision and returns to pending", async () => {
  const originalConnect = pool.connect;
  const executed = [];
  pool.connect = async () => ({
    async query(sql, values) {
      executed.push({ sql, values });
      if (/FOR UPDATE OF sr/.test(sql)) return { rows: [{
        ...base,
        client_budget_usd: 1000,
        approved_budget_usd: 1100,
        admin_budget_adjustment_type: "percentage",
        admin_budget_adjustment_mode: "markup",
        admin_budget_adjustment_value: 10,
      }] };
      if (/UPDATE service_requests SET/.test(sql)) return { rows: [{
        ...base, title: "Revised", moderation_status: "pending", budget_usd: 1250,
        client_budget_usd: 1250, approved_budget_usd: 1250,
        admin_budget_adjustment_type: "none", admin_budget_adjustment_mode: "none",
        admin_budget_adjustment_value: 0,
      }] };
      return { rows: [] };
    },
    release() {},
  });
  const res = response();
  try {
    await updateServiceRequest({ params: { id: 7 }, body: { title: "Revised", budgetUsd: 1250 }, user: { id: 30, role_id: 3 } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.moderationStatus, "pending");
    assert.equal(res.body.data.clientBudgetUsd, 1250);
    assert.equal(res.body.data.approvedBudgetUsd, 1250);
    const update = executed.find(({ sql }) => /UPDATE service_requests SET/.test(sql));
    assert.match(update.sql, /moderation_status =/);
    assert.match(update.sql, /client_budget_usd =/);
    assert.match(update.sql, /approved_budget_usd =/);
    assert.match(update.sql, /admin_budget_adjustment_type =/);
  } finally {
    pool.connect = originalConnect;
  }
});

test("controller blocks approved Client edit after quotation and blocks unsafe Admin edit", async () => {
  const originalConnect = pool.connect;
  const run = async (row, user) => {
    pool.connect = async () => ({
      async query(sql) { return /FOR UPDATE OF sr/.test(sql) ? { rows: [row] } : { rows: [] }; },
      release() {},
    });
    const res = response();
    await updateServiceRequest({ params: { id: row.id }, body: { title: "Changed" }, user }, res);
    return res;
  };
  try {
    const quoted = await run({ ...base, quotation_count: 1 }, { id: 30, role_id: 3 });
    assert.equal(quoted.statusCode, 409);
    assert.equal(quoted.body.code, "REQUEST_EDIT_QUOTATIONS_EXIST");
    const accepted = await run({ ...base, accepted_quotation_id: 10 }, { id: 1, role_id: 1 });
    assert.equal(accepted.statusCode, 409);
    assert.equal(accepted.body.code, "REQUEST_EDIT_WORKFLOW_LOCKED");
  } finally {
    pool.connect = originalConnect;
  }
});
