import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../src/config/db.js";
import { getServiceRequests, getServiceRequestById } from "../src/controllers/serviceRequestController.js";
import { createQuotation } from "../src/controllers/quotationController.js";

const response = () => ({
  statusCode: 200, body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test("pending re-moderation state removes Consultant list/detail/quotation access until re-approved", async () => {
  const originalQuery = pool.query;
  const sql = [];
  try {
    pool.query = async (text) => { sql.push(text); return { rows: [] }; };
    const listRes = response();
    await getServiceRequests({ query: {}, user: { id: 2, role_id: 2 } }, listRes);
    assert.equal(listRes.statusCode, 200);
    assert.match(sql.at(-1), /sr\.moderation_status = 'approved'/);

    const detailRes = response();
    await getServiceRequestById({ params: { id: 7 }, user: { id: 2, role_id: 2 } }, detailRes);
    assert.equal(detailRes.statusCode, 404);
    assert.match(sql.at(-1), /sr\.moderation_status = 'approved'/);

    pool.query = async () => ({ rows: [{ id: 7, status: "open", moderation_status: "pending" }] });
    const quoteRes = response();
    await createQuotation({ body: { serviceRequestId: 7, totalQuoteUsd: 1000 }, user: { id: 2, role_id: 2 } }, quoteRes);
    assert.equal(quoteRes.statusCode, 404);
    assert.equal(quoteRes.body.code, "REQUEST_NOT_APPROVED");

    // The same list/detail/quotation gates use moderation_status='approved', so Admin re-approval restores visibility.
    assert.match(sql[0], /moderation_status = 'approved'/);
  } finally {
    pool.query = originalQuery;
  }
});
