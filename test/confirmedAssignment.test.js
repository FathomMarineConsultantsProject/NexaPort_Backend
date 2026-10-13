import assert from "node:assert/strict";
import test from "node:test";
import { confirmAcceptedExpertAssignment } from "../src/services/confirmedAssignmentService.js";

const actor = { id: 1, role_id: 1 };
const fixture = (changes = {}) => {
  const state = {
    request: { id: 7, status: "assigned", moderation_status: "approved", requester_user_id: 30, active_proposal_id: 100, accepted_expert_id: 12, accepted_quotation_id: 50 },
    proposal: { id: 100, status: "approved", quotation_id: 50, expert_id: 12, decided_at: "2026-10-01", decided_by_user_id: 30, approved_quotation_revision_id: 201 },
    quote: { id: 50, status: "accepted", expert_id: 12, internal_review_status: "approved", latest_revision_id: 201, approved_revision_id: 201 },
    authorized: true, assignments: [], ...changes,
  };
  const statements = [];
  // Serialize fake transactions just as the service's request row lock does.
  let tail = Promise.resolve();
  const connectionPool = { async connect() {
    let unlock; const lock = new Promise((resolve) => { unlock = resolve; });
    const previous = tail; tail = lock; await previous;
    return { release: unlock, async query(sql, values) {
      statements.push(sql);
      if (sql.includes("FROM service_requests")) return { rows: state.request ? [state.request] : [] };
      if (sql.includes("FROM commercial_proposals")) return { rows: state.proposal ? [state.proposal] : [] };
      if (sql.includes("FROM quotations")) return { rows: state.quote ? [state.quote] : [] };
      if (sql.includes("FROM quotation_revisions")) return { rows: state.authorized ? [{ id: 201 }] : [] };
      if (sql.includes("SELECT expert_id FROM request_expert_assignments")) return { rows: [...state.assignments] };
      if (sql.includes("INSERT INTO request_expert_assignments")) state.assignments.push({ expert_id: values[1] });
      return { rows: [] };
    } };
  } };
  return { state, statements, run: (options = {}) => confirmAcceptedExpertAssignment({ requestId: 7, expertIds: [12], actor, connectionPool, ...options }) };
};

test("assignment rejects unauthorized actors and multiple Experts before connecting", async () => {
  const f = fixture();
  for (const role_id of [2, 3, 4]) await assert.rejects(f.run({ actor: { id: 1, role_id } }), { code: "ACCESS_DENIED" });
  await assert.rejects(f.run({ expertIds: [12, 13] }), { code: "ONE_ACCEPTED_EXPERT_REQUIRED" });
  assert.equal(f.statements.length, 0);
});

test("unapproved, stale, wrong-owner and mismatched assignments roll back without writing", async () => {
  for (const mutate of [
    (s) => { s.request.status = "open"; },
    (s) => { s.request.moderation_status = "pending"; },
    (s) => { s.proposal = null; },
    (s) => { s.proposal.status = "sent"; },
    (s) => { s.proposal.decided_by_user_id = 31; },
    (s) => { s.proposal.expert_id = 13; },
    (s) => { s.request.accepted_quotation_id = 51; },
    (s) => { s.authorized = false; },
    (s) => { s.assignments = [{ expert_id: 13 }]; },
  ]) {
    const f = fixture(); mutate(f.state);
    await assert.rejects(f.run(), (error) => error.status === 409);
    assert.equal(f.statements.at(-1), "ROLLBACK");
    assert.ok(!f.statements.some((sql) => sql.includes("INSERT INTO request_expert_assignments")));
  }
});

test("confirmed assignment retries and competing calls produce one record and one audit event", async () => {
  const f = fixture();
  const results = await Promise.all([f.run(), f.run()]);
  assert.deepEqual(results.map((r) => r.alreadyAssigned), [false, true]);
  await f.run();
  assert.equal(f.state.assignments.length, 1);
  assert.equal(f.statements.filter((sql) => sql.includes("INSERT INTO public.admin_audit_logs")).length, 1);
});

test("reopened negotiations do not invalidate the authorized accepted assignment", async () => {
  const f=fixture(); f.state.quote.latest_revision_id=202; f.state.quote.approved_revision_id=null; f.state.quote.internal_review_status="revision_requested";
  f.state.assignments=[{expert_id:12}];
  assert.equal((await f.run()).alreadyAssigned,true);
  assert.ok(!f.statements.some(sql=>sql.includes("INSERT INTO request_expert_assignments")));
});
