import assert from "node:assert/strict";
import test from "node:test";
import { completeSubmission, reserveSubmission, submissionHash } from "../src/services/requestSubmissionService.js";

const key = "30e6f596-e254-45d4-a7a0-9b82d37774ba";

test("equivalent payloads hash identically and changed payloads do not", () => {
  assert.equal(submissionHash({ title: "A", ports: [1], nested: { b: 2, a: 1 } }),
    submissionHash({ nested: { a: 1, b: 2 }, ports: [1], title: "A", submissionKey: key }));
  assert.notEqual(submissionHash({ title: "A" }), submissionHash({ title: "B" }));
});

test("reservation records and replays a committed request for the same user and key", async () => {
  const body = { title: "Inspection", submissionKey: key };
  const row = { hash: null, response: null };
  const db = { query: async (sql, values) => {
    if (sql.startsWith("INSERT INTO service_request_submissions")) {
      if (row.hash) return { rowCount: 0 };
      row.hash = values[2]; return { rowCount: 1 };
    }
    if (sql.startsWith("SELECT payload_hash")) return { rows: [{ payload_hash: row.hash, response: row.response }] };
    if (sql.startsWith("UPDATE service_request_submissions")) { row.response = JSON.parse(values[3]); return { rowCount: 1 }; }
    throw Error(sql);
  } };
  const reserved = await reserveSubmission(db, 5, body);
  assert.equal(reserved.replay, null);
  await completeSubmission(db, 5, reserved, 42, { success: true, data: { id: 42 } });
  assert.deepEqual((await reserveSubmission(db, 5, body)).replay, { success: true, data: { id: 42 } });
  await assert.rejects(reserveSubmission(db, 5, { ...body, title: "Other" }), { status: 409 });
});

test("a concurrent reservation waits for the first committed response and replays it", async () => {
  let releaseCommit;
  const committed = new Promise((resolve) => { releaseCommit = resolve; });
  const row = { hash: null, response: null };
  const db = { query: async (sql, values) => {
    if (sql.startsWith("INSERT INTO service_request_submissions")) {
      if (!row.hash) { row.hash = values[2]; return { rowCount: 1 }; }
      await committed; return { rowCount: 0 };
    }
    if (sql.startsWith("SELECT payload_hash")) return { rows: [{ payload_hash: row.hash, response: row.response }] };
    if (sql.startsWith("UPDATE service_request_submissions")) { row.response = JSON.parse(values[3]); releaseCommit(); return { rowCount: 1 }; }
    throw Error(sql);
  } };
  const body = { title: "Inspection", submissionKey: key };
  const first = await reserveSubmission(db, 5, body);
  const second = reserveSubmission(db, 5, body);
  await completeSubmission(db, 5, first, 42, { success: true, data: { id: 42 } });
  assert.deepEqual((await second).replay, { success: true, data: { id: 42 } });
});
