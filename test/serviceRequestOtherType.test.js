import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { pool } from "../src/config/db.js";
import {
  createServiceRequest,
  getServiceRequests,
  updateServiceRequest,
} from "../src/controllers/serviceRequestController.js";
import { allowRoles } from "../src/middlewares/authMiddleware.js";

const baseBody = {
  serviceType: "Audit",
  serviceCategory: "Internal Audit",
  title: "Test request",
  scopeOfWork: "Test scope",
};

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const createClient = (capture) => ({
  async query(sql, values = []) {
    if (/INSERT INTO service_requests/.test(sql)) {
      capture.sql = sql;
      capture.values = values;
      return { rows: [{
        id: 9,
        service_type: values[0],
        service_category: values[1],
        service_type_other: values[2],
        title: values[3],
        scope_of_work: values[4],
        moderation_status: values[20],
        status: values[21],
      }] };
    }
    return { rows: [] };
  },
  release() {},
});

const runCreate = async (body) => {
  const capture = {};
  const originalConnect = pool.connect;
  pool.connect = async () => createClient(capture);
  const res = response();
  try {
    await createServiceRequest({ body, user: { id: 3, role_id: 3, full_name: "Client" } }, res);
    return { capture, res };
  } finally {
    pool.connect = originalConnect;
  }
};

for (const [type, category] of [["Audit", "Internal Audit"], ["Inspection", "Pre-purchase"], ["Survey", "Condition Survey"]]) {
  test(`${type} request creation still succeeds`, async () => {
    const { capture, res } = await runCreate({ ...baseBody, serviceType: type, serviceCategory: category });
    assert.equal(res.statusCode, 201);
    assert.equal(capture.values[0], type);
    assert.equal(capture.values[1], category);
    assert.equal(capture.values[2], null);
  });
}

test("Other request with valid details succeeds and returns camelCase details", async () => {
  const { res } = await runCreate({ ...baseBody, serviceType: "Other", serviceCategory: "ignored", serviceTypeOther: "  Underwater drone hull inspection  " });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.serviceTypeOther, "Underwater drone hull inspection");
});

test("Other request stores canonical type, category, and trimmed details", async () => {
  const { capture } = await runCreate({ ...baseBody, serviceType: "Other", serviceTypeOther: "  Specialist rigging review  " });
  assert.deepEqual(capture.values.slice(0, 3), ["Other", "Other", "Specialist rigging review"]);
  assert.match(capture.sql, /service_type_other/);
});

test("Other request is returned with serviceTypeOther", async () => {
  const { res } = await runCreate({ ...baseBody, serviceType: "Other", serviceTypeOther: "Specialist rigging review" });
  assert.equal(res.body.data.serviceTypeOther, "Specialist rigging review");
});

for (const [name, value] of [["blank", ""], ["whitespace-only", "   "], ["fewer than 3 characters", "ab"], ["over 500 characters", "x".repeat(501)]]) {
  test(`Other request with ${name} details fails safely`, async () => {
    const { res } = await runCreate({ ...baseBody, serviceType: "Other", serviceTypeOther: value });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "SERVICE_REQUEST_VALIDATION_FAILED");
    assert.ok(res.body.field_errors.serviceTypeOther);
    assert.equal("error" in res.body, false);
  });
}

test("normal request ignores supplied Other details and stores NULL", async () => {
  const { capture } = await runCreate({ ...baseBody, serviceTypeOther: "stale details" });
  assert.equal(capture.values[2], null);
});

test("unsupported Service Type fails", async () => {
  const { res } = await runCreate({ ...baseBody, serviceType: "Custom" });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.field_errors.serviceType);
});

test("existing rows with NULL service_type_other still load", async () => {
  const originalQuery = pool.query;
  pool.query = async () => ({ rows: [{ id: 1, service_type: "Audit", service_category: "Internal Audit", service_type_other: null, requester_user_id: 3 }] });
  const res = response();
  try {
    await getServiceRequests({ query: {}, user: { id: 3, role_id: 3 } }, res);
    assert.equal(res.body.data[0].serviceTypeOther, null);
  } finally {
    pool.query = originalQuery;
  }
});

const runAdminUpdate = async (existing, body) => {
  const capture = {};
  const originalConnect = pool.connect;
  pool.connect = async () => ({
    async query(sql, values = []) {
      if (/SELECT \* FROM service_requests/.test(sql)) return { rows: [existing] };
      if (/UPDATE service_requests SET/.test(sql)) {
        capture.sql = sql;
        capture.values = values;
        return { rows: [{ ...existing, service_type: values[0], service_category: values[1], service_type_other: values[2] }] };
      }
      return { rows: [] };
    },
    release() {},
  });
  const res = response();
  try {
    await updateServiceRequest({ params: { id: "7" }, body, user: { id: 1, role_id: 1 } }, res);
    return { capture, res };
  } finally {
    pool.connect = originalConnect;
  }
};

test("Super Admin can edit a normal request into Other", async () => {
  const { capture, res } = await runAdminUpdate({ id: 7, moderation_status: "pending", service_type: "Audit", service_category: "Internal", service_type_other: null }, { serviceType: "Other", serviceTypeOther: "  Propeller balancing  " });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(capture.values.slice(0, 3), ["Other", "Other", "Propeller balancing"]);
});

test("Super Admin can edit Other into a normal type and clears the column", async () => {
  const { capture } = await runAdminUpdate({ id: 7, moderation_status: "pending", service_type: "Other", service_category: "Other", service_type_other: "Old details" }, { serviceType: "Inspection", serviceCategory: "Pre-purchase" });
  assert.deepEqual(capture.values.slice(0, 3), ["Inspection", "Pre-purchase", null]);
});

test("Consultant-safe response includes Other service details", async () => {
  const originalQuery = pool.query;
  pool.query = async () => ({ rows: [{ id: 2, service_type: "Other", service_type_other: "Drone hull inspection", inspection_type: "Other — Drone hull inspection", vessel_type: "Bulk carrier", inspection_date: "2026-09-01", port_of_inspection: "Goa" }] });
  const res = response();
  try {
    await getServiceRequests({ query: {}, user: { id: 2, role_id: 2 } }, res);
    assert.equal(res.body.data[0].serviceTypeOther, "Drone hull inspection");
  } finally {
    pool.query = originalQuery;
  }
});

test("Consultant-safe response still hides protected request fields", async () => {
  const originalQuery = pool.query;
  pool.query = async () => ({ rows: [{ id: 2, service_type: "Other", service_type_other: "Drone hull inspection", requester_name: "Hidden", title: "Hidden", budget_usd: 9000 }] });
  const res = response();
  try {
    await getServiceRequests({ query: {}, user: { id: 2, role_id: 2 } }, res);
    assert.deepEqual(Object.keys(res.body.data[0]).sort(), ["id", "inspectionDate", "inspectionType", "portOfInspection", "serviceType", "serviceTypeOther", "vesselType"].sort());
  } finally {
    pool.query = originalQuery;
  }
});

test("request moderation remains pending on creation", async () => {
  const { capture, res } = await runCreate(baseBody);
  assert.equal(capture.values[20], "pending");
  assert.equal(res.body.data.moderationStatus, "pending");
});

test("existing request approval behavior and safe notification summary remain present", async () => {
  const source = await readFile(new URL("../src/controllers/serviceRequestController.js", import.meta.url), "utf8");
  assert.match(source, /moderation_status = 'approved'/);
  assert.match(source, /createServiceRequestApprovedNotifications/);
  assert.match(source, /`Other: \$\{details\.slice\(0, 120\)\}`/);
});

test("role 2 still cannot create a request", () => {
  const guard = allowRoles(1, 3);
  let admitted = false;
  const res = response();
  guard({ user: { role_id: 2 } }, res, () => { admitted = true; });
  assert.equal(admitted, false);
  assert.equal(res.statusCode, 403);
});
