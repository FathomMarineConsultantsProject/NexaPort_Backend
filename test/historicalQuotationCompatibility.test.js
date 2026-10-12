import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createOrUpdateDraftProposal, sendProposalToClient } from "../src/services/commercialProposalService.js";

const database = (authorized) => {
  const writes = [];
  const proposal = { id: 102, service_request_id: 7, quotation_id: 50, expert_id: 12,
    approved_quotation_revision_id: 201, revision_number: 2, status: "draft", client_total_usd: 1250 };
  return { writes, async query(sql, values) {
    if (sql.includes("FROM service_requests WHERE")) return { rows: [{ id: 7, status: "open", moderation_status: "approved", requester_user_id: 30 }] };
    if (sql.includes("FROM quotations q")) return { rows: [{ id: 50, expert_id: 12, latest_revision_id: 201, approved_revision_id: 201,
      moderation_status: "approved", request_status: "open", internal_review_status: "approved", ...(authorized ? { revision_id: 201 } : {}) }].filter(() => !sql.includes("r.id AS revision_id") || authorized) };
    if (sql.includes("FROM quotation_revisions r")) return { rows: authorized ? [{ id: 201, currency: "USD", base_fee: "1000", consultant_total: "1000" }] : [] };
    if (sql.includes("MAX(revision_number)")) return { rows: [{ max_rev: 1 }] };
    if (sql.includes("FROM commercial_proposals WHERE") && !sql.includes("status = 'draft' FOR UPDATE")) return { rows: [proposal] };
    if (sql.includes("FROM commercial_proposals cp")) return { rows: [proposal] };
    if (sql.includes("INSERT INTO commercial_proposals")) { writes.push({ sql, values }); return { rows: [proposal] }; }
    if (/UPDATE commercial_proposals|INSERT INTO public.admin_notifications/.test(sql)) writes.push({ sql, values });
    if (sql.includes("RETURNING *")) return { rows: [proposal] };
    return { rows: [] };
  } };
};

test("authorized historical revision can create a new financial snapshot and send it", async () => {
  const db = database(true);
  const proposal = await createOrUpdateDraftProposal({ requestId: 7, quotationId: 50, actorUserId: 1, queryable: db });
  assert.equal(proposal.revision_number, 2);
  const inserted = db.writes.find(({ sql }) => sql.includes("INSERT INTO commercial_proposals"));
  assert.equal(inserted.values[8], 1250);
  assert.equal(inserted.values[13], 201);
  await sendProposalToClient({ requestId: 7, proposalId: 102, actorUserId: 1, queryable: db });
  assert.ok(db.writes.some(({ sql }) => sql.includes("admin_notifications")));
});

test("an approved label alone cannot create or send a proposal", async () => {
  const db = database(false);
  await assert.rejects(createOrUpdateDraftProposal({ requestId: 7, quotationId: 50, actorUserId: 1, queryable: db }), { code: "QUOTATION_INTERNAL_APPROVAL_REQUIRED" });
  await assert.rejects(sendProposalToClient({ requestId: 7, proposalId: 102, actorUserId: 1, queryable: db }), { code: "QUOTATION_INTERNAL_APPROVAL_REQUIRED" });
  assert.equal(db.writes.length, 0);
});

test("corrective source requires sent historical evidence, preserves versions and records no invented actor", async () => {
  const sql = await readFile(new URL("../sql/quotation_legacy_authorization_003.sql", import.meta.url), "utf8");
  assert.match(sql, /r.revision_number=1/);
  assert.match(sql, /cp.sent_at IS NOT NULL/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM public.quotation_revision_decisions/);
  assert.match(sql, /cp.approved_quotation_revision_id=r.id/);
  assert.match(sql, /ON CONFLICT\(revision_id\) DO NOTHING/);
  assert.doesNotMatch(sql, /INSERT INTO public.quotation_revision_decisions|UPDATE public.quotation_revisions|UPDATE public.commercial_proposals/);
});
