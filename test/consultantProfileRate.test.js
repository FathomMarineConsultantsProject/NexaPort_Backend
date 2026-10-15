import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../src/config/db.js";
import { updateConsultantAsAdmin } from "../src/controllers/adminAdministrationController.js";
import { updateExpert } from "../src/controllers/expertController.js";

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test("Admin profile rate update preserves historical commercial amounts", async (t) => {
  const history = { quotation: 1200, revision: 1350, proposal: 1600, invoice: 1500 };
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("SELECT e.id, e.user_id")) return { rows: [{ id: 7, user_id: 12 }] };
      if (/\b(quotations|quotation_revisions|commercial_proposals|inspection_invoices)\b/i.test(sql)) {
        throw new Error("Profile rate update must not touch historical commercial tables");
      }
      return { rows: [] };
    },
    release() {},
  };
  t.mock.method(pool, "connect", async () => client);
  const res = response();
  await updateConsultantAsAdmin({ params: { expertId: "7" }, user: { id: 1 }, body: { expert: { day_rate_usd: 275.50 } } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(history, { quotation: 1200, revision: 1350, proposal: 1600, invoice: 1500 });
  assert.deepEqual(calls.find(({ sql }) => sql.startsWith("UPDATE experts"))?.values, [275.50, 7]);
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), true);
});

test("Admin profile rate rejects negative and over-precision amounts", async (t) => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("SELECT e.id, e.user_id")) return { rows: [{ id: 7, user_id: 12 }] };
      return { rows: [] };
    },
    release() {},
  };
  t.mock.method(pool, "connect", async () => client);
  for (const value of [-1, 1.234, "invalid"]) {
    const res = response();
    await updateConsultantAsAdmin({ params: { expertId: "7" }, user: { id: 1 }, body: { expert: { day_rate_usd: value } } }, res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls.some((sql) => sql.startsWith("UPDATE experts")), false);
});

test("Consultant profile owner cannot change the Admin-controlled day rate", async (t) => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("SELECT * FROM experts")) return { rows: [{ id: 7, user_id: 12 }] };
      return { rows: [] };
    },
    release() {},
  };
  t.mock.method(pool, "connect", async () => client);
  const res = response();
  await updateExpert({ params: { id: "7" }, user: { id: 12, role_id: 2 }, body: { day_rate_usd: 999 } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.some((sql) => sql.includes("UPDATE experts")), false);
});
