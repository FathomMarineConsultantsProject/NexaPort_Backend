import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { pool } from "../src/config/db.js";
import { getServiceRequestDropdowns } from "../src/controllers/masterController.js";
import { createServiceRequest } from "../src/controllers/serviceRequestController.js";

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test("inspection catalogue migration seeds 12 verticals and 84 methods", async () => {
  const sql = await readFile(new URL("../sql/service_request_inspection_catalogue_001.sql", import.meta.url), "utf8");
  const verticalSection = sql.match(/INSERT INTO public\.inspection_verticals[\s\S]*?ON CONFLICT/)[0];
  const methodSection = sql.match(/WITH seed\(vertical_slug, slug, name, display_order\) AS \([\s\S]*?\),\s*resolved/)[0];

  assert.equal((verticalSection.match(/\('[^']+', '[^']+', \d+\)/g) || []).length, 12);
  assert.equal((methodSection.match(/\('[^']+', '[^']+', '[^']+', \d+\)/g) || []).length, 84);
  assert.match(sql, /ALTER TABLE public\.service_requests\s+ADD COLUMN IF NOT EXISTS inspection_method_id BIGINT/);
});

test("master dropdowns include normalized inspection catalogue", async () => {
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    if (/FROM inspection_verticals v/.test(sql)) {
      return { rows: [
        { vertical_id: 1, vertical_slug: "navigation", vertical_name: "Navigation", method_id: 42, method_slug: "ecdis-audits", method_name: "ECDIS Audits" },
      ] };
    }
    if (/master_service_categories/.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  const res = response();

  try {
    await getServiceRequestDropdowns({}, res);
    assert.deepEqual(res.body.data.inspectionVerticals, [{
      id: 1,
      slug: "navigation",
      name: "Navigation",
      methods: [{ id: 42, slug: "ecdis-audits", name: "ECDIS Audits" }],
    }]);
  } finally {
    pool.query = originalQuery;
  }
});

test("create request derives snapshots from inspectionMethodId", async () => {
  const capture = {};
  const originalConnect = pool.connect;
  pool.connect = async () => ({
    async query(sql, values = []) {
      if (/FROM inspection_methods m/.test(sql)) {
        return { rows: [{ id: 42, name: "ECDIS Audits", vertical_name: "Navigation" }] };
      }
      if (/INSERT INTO service_requests/.test(sql)) {
        capture.sql = sql;
        capture.values = values;
        return { rows: [{
          id: 12,
          service_type: values[0],
          service_category: values[1],
          service_type_other: values[2],
          inspection_method_id: values[3],
          title: values[4],
          scope_of_work: values[5],
          requester_user_id: 3,
        }] };
      }
      return { rows: [] };
    },
    release() {},
  });
  const res = response();

  try {
    await createServiceRequest({
      body: {
        inspectionMethodId: 42,
        serviceType: "Ignored client value",
        serviceCategory: "Ignored client category",
        title: "ECDIS readiness",
        scopeOfWork: "Check bridge systems",
      },
      user: { id: 3, role_id: 3, full_name: "Client" },
    }, res);

    assert.equal(res.statusCode, 201);
    assert.match(capture.sql, /inspection_method_id/);
    assert.deepEqual(capture.values.slice(0, 4), ["ECDIS Audits", "Navigation", null, 42]);
    assert.equal(res.body.data.inspectionMethodId, 42);
    assert.equal(res.body.data.inspectionType, "ECDIS Audits");
    assert.equal(res.body.data.inspectionVertical, "Navigation");
  } finally {
    pool.connect = originalConnect;
  }
});

test("invalid inspectionMethodId fails field validation", async () => {
  const originalConnect = pool.connect;
  pool.connect = async () => ({
    async query() { return { rows: [] }; },
    release() {},
  });
  const res = response();

  try {
    await createServiceRequest({
      body: { inspectionMethodId: 999, title: "Bad", scopeOfWork: "Bad method" },
      user: { id: 3, role_id: 3, full_name: "Client" },
    }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.field_errors.inspectionMethodId, "Select a valid inspection type.");
  } finally {
    pool.connect = originalConnect;
  }
});
