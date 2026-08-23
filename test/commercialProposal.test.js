import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../src/config/db.js";
import {
  calculateProposalFinancials,
  mapProposalRow,
  createOrUpdateDraftProposal,
  sendProposalToClient,
  rejectProposalByClient,
  approveProposalByClient,
} from "../src/services/commercialProposalService.js";
import { acceptQuotation } from "../src/controllers/quotationController.js";
import { confirmWorkflowQuotation } from "../src/services/inspectionWorkflowService.js";

const mockResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(data) {
    this.body = data;
    return this;
  },
});

test("calculateProposalFinancials computes base, expenses, markup, and client total", () => {
  const quote = {
    total_quote_usd: 3000,
    travel_cost: 400,
    accommodation_cost: 300,
    report_fee: 200,
    urgency_surcharge: 100,
  };
  const financials = calculateProposalFinancials(quote, 500);
  assert.equal(financials.consultantBaseQuoteUsd, 3000);
  assert.equal(financials.consultantExpensesUsd, 1000);
  assert.equal(financials.consultantTotalUsd, 4000);
  assert.equal(financials.adminMarkupUsd, 500);
  assert.equal(financials.clientTotalUsd, 4500);
});

test("mapProposalRow sanitizes data strictly by role", () => {
  const row = {
    id: "101",
    service_request_id: "7",
    quotation_id: "50",
    expert_id: "12",
    revision_number: "1",
    consultant_base_quote_usd: "3000",
    consultant_expenses_usd: "500",
    consultant_total_usd: "3500",
    admin_markup_usd: "600",
    client_total_usd: "4100",
    currency: "USD",
    client_notes: "Included 2 days attendance",
    internal_admin_notes: "Consultant agreed to 10% discount",
    estimated_attendance_days: "2",
    status: "sent",
    created_by_user_id: 1,
    sent_by_user_id: 1,
    sent_at: new Date().toISOString(),
    expert_name: "Capt. John Doe",
    expert_rating: "4.8",
  };

  // Super Admin (Role 1)
  const adminView = mapProposalRow(row, { id: 1, role_id: 1 });
  assert.equal(adminView.adminMarkupUsd, 600);
  assert.equal(adminView.internalAdminNotes, "Consultant agreed to 10% discount");
  assert.equal(adminView.consultantTotalUsd, 3500);
  assert.equal(adminView.clientTotalUsd, 4100);

  // Client (Role 3)
  const clientView = mapProposalRow(row, { id: 30, role_id: 3 });
  assert.equal(clientView.finalTotalUsd, 4100);
  assert.equal(clientView.adminMarkupUsd, undefined);
  assert.equal(clientView.internalAdminNotes, undefined);
  assert.equal(clientView.consultantBaseQuoteUsd, undefined);
  assert.equal(clientView.clientNotes, "Included 2 days attendance");

  // Consultant (Role 2)
  const consultantView = mapProposalRow(row, { id: 40, role_id: 2 });
  assert.equal(consultantView.consultantTotalUsd, 3500);
  assert.equal(consultantView.finalTotalUsd, undefined);
  assert.equal(consultantView.clientTotalUsd, undefined);
  assert.equal(consultantView.adminMarkupUsd, undefined);
  assert.equal(consultantView.internalAdminNotes, undefined);
});

test("createOrUpdateDraftProposal creates draft with calculated financials and revision number", async () => {
  const executed = [];
  const mockQueryable = {
    async query(sql, values) {
      executed.push({ sql, values });
      const s = sql.toUpperCase();
      if (s.includes("FROM QUOTATIONS")) {
        return {
          rows: [
            {
              id: 50,
              service_request_id: 7,
              expert_id: 12,
              total_quote_usd: 3000,
              travel_cost: 200,
              accommodation_cost: 300,
              report_fee: 0,
              urgency_surcharge: 0,
              attendance_days: 2,
              moderation_status: "approved",
              request_status: "open",
            },
          ],
        };
      }
      if (s.includes("STATUS = 'DRAFT' FOR UPDATE")) {
        return { rows: [] };
      }
      if (s.includes("MAX(REVISION_NUMBER)")) {
        return { rows: [{ max_rev: 0 }] };
      }
      if (s.includes("INSERT INTO COMMERCIAL_PROPOSALS")) {
        return {
          rows: [
            {
              id: 101,
              service_request_id: 7,
              quotation_id: 50,
              expert_id: 12,
              revision_number: 1,
              consultant_base_quote_usd: 3000,
              consultant_expenses_usd: 500,
              consultant_total_usd: 3500,
              admin_markup_usd: 500,
              client_total_usd: 4000,
              status: "draft",
            },
          ],
        };
      }
      if (s.includes("FROM COMMERCIAL_PROPOSALS CP")) {
        return {
          rows: [
            {
              id: 101,
              service_request_id: 7,
              quotation_id: 50,
              expert_id: 12,
              revision_number: 1,
              consultant_base_quote_usd: 3000,
              consultant_expenses_usd: 500,
              consultant_total_usd: 3500,
              admin_markup_usd: 500,
              client_total_usd: 4000,
              status: "draft",
              expert_name: "Capt. John Doe",
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const proposal = await createOrUpdateDraftProposal({
    requestId: 7,
    quotationId: 50,
    adminMarkupUsd: 500,
    clientNotes: "Standard terms",
    internalAdminNotes: "Verified surveyor availability",
    estimatedAttendanceDays: 2,
    actorUserId: 1,
    queryable: mockQueryable,
  });

  assert.equal(proposal.id, 101);
  assert.equal(proposal.status, "draft");
  assert.equal(proposal.revision_number, 1);
  assert.equal(proposal.client_total_usd, 4000);
});

test("sendProposalToClient transitions proposal to sent, sets pending_client_approval and notifies client", async () => {
  const executed = [];
  const mockQueryable = {
    async query(sql, values) {
      executed.push({ sql, values });
      const s = sql.toUpperCase();
      if (s.includes("FROM SERVICE_REQUESTS") && s.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: 7,
              requester_user_id: 30,
              moderation_status: "approved",
              status: "open",
              vessel_name: "MV Atlantic",
              service_type: "Condition Survey",
            },
          ],
        };
      }
      if (s.includes("FROM COMMERCIAL_PROPOSALS") && s.includes("STATUS = 'DRAFT'")) {
        return {
          rows: [
            {
              id: 101,
              service_request_id: 7,
              quotation_id: 50,
              expert_id: 12,
              revision_number: 1,
              client_total_usd: 4000,
              status: "draft",
            },
          ],
        };
      }
      if (s.includes("UPDATE COMMERCIAL_PROPOSALS") && s.includes("STATUS = 'SENT'")) {
        return {
          rows: [
            {
              id: 101,
              service_request_id: 7,
              quotation_id: 50,
              expert_id: 12,
              revision_number: 1,
              client_total_usd: 4000,
              status: "sent",
            },
          ],
        };
      }
      if (s.includes("FROM COMMERCIAL_PROPOSALS CP")) {
        return {
          rows: [
            {
              id: 101,
              service_request_id: 7,
              quotation_id: 50,
              expert_id: 12,
              revision_number: 1,
              client_total_usd: 4000,
              status: "sent",
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const sent = await sendProposalToClient({
    requestId: 7,
    actorUserId: 1,
    queryable: mockQueryable,
  });

  assert.equal(sent.status, "sent");
  const requestUpdate = executed.find(({ sql }) => sql.toUpperCase().includes("UPDATE SERVICE_REQUESTS"));
  assert.ok(requestUpdate, "Expected UPDATE service_requests query");
  assert.match(requestUpdate.sql, /pending_client_approval/);

  const notification = executed.find(({ sql }) => sql.toUpperCase().includes("ADMIN_NOTIFICATIONS"));
  assert.ok(notification, "Expected admin_notifications insert");
});

test("rejectProposalByClient records reason, reverts status to open and notifies Super Admin", async () => {
  const executed = [];
  const mockQueryable = {
    async query(sql, values) {
      executed.push({ sql, values });
      const s = sql.toUpperCase();
      if (s.includes("FOR UPDATE OF CP, SR")) {
        return {
          rows: [
            {
              id: 101,
              service_request_id: 7,
              requester_user_id: 30,
              status: "sent",
              revision_number: 1,
              vessel_name: "MV Atlantic",
            },
          ],
        };
      }
      if (s.includes("UPDATE COMMERCIAL_PROPOSALS") && s.includes("STATUS = 'REJECTED'")) {
        return {
          rows: [
            {
              id: 101,
              service_request_id: 7,
              status: "rejected",
              client_rejection_reason: "Price exceeds budget",
            },
          ],
        };
      }
      if (s.includes("FROM COMMERCIAL_PROPOSALS CP")) {
        return {
          rows: [
            {
              id: 101,
              service_request_id: 7,
              status: "rejected",
              client_rejection_reason: "Price exceeds budget",
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const rejected = await rejectProposalByClient({
    proposalId: 101,
    rejectionReason: "Price exceeds budget",
    actorUserId: 30,
    queryable: mockQueryable,
  });

  assert.equal(rejected.status, "rejected");
  const requestUpdate = executed.find(({ sql }) => sql.toUpperCase().includes("UPDATE SERVICE_REQUESTS"));
  assert.ok(requestUpdate, "Expected UPDATE service_requests query");
  assert.match(requestUpdate.sql, /status = 'open'/);

  const notification = executed.find(({ sql }) => sql.toUpperCase().includes("ADMIN_NOTIFICATIONS"));
  assert.ok(notification, "Expected admin_notifications insert");
});

test("approveProposalByClient executes full transaction: accepts quote, assigns expert, advances workflow", async () => {
  const executed = [];
  const mockQueryable = {
    async query(sql, values) {
      executed.push({ sql, values });
      const s = sql.toUpperCase();
      if (s.includes("FOR UPDATE OF CP, SR, Q")) {
        return {
          rows: [
            {
              id: 101,
              service_request_id: 7,
              quotation_id: 50,
              expert_id: 12,
              revision_number: 1,
              consultant_total_usd: 3500,
              admin_markup_usd: 500,
              client_total_usd: 4000,
              status: "sent",
              requester_user_id: 30,
              moderation_status: "approved",
              vessel_name: "MV Atlantic",
              expert_user_id: 40,
            },
          ],
        };
      }
      if (s.includes("FROM COMMERCIAL_PROPOSALS CP")) {
        return {
          rows: [
            {
              id: 101,
              service_request_id: 7,
              status: "approved",
              client_total_usd: 4000,
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const result = await approveProposalByClient({
    proposalId: 101,
    actorUserId: 30,
    queryable: mockQueryable,
  });

  assert.equal(result.alreadyApproved, false);
  assert.equal(result.serviceRequestId, 7);
  assert.equal(result.expertId, 12);

  // 1. Rejected competing quotations
  const rejectCompeting = executed.find(({ sql }) => /UPDATE\s+quotations/i.test(sql) && /status\s*=\s*'rejected'/i.test(sql));
  assert.ok(rejectCompeting, "Expected competing quotations update");

  // 2. Accepted selected quotation
  const acceptSelected = executed.find(({ sql }) => /UPDATE\s+quotations/i.test(sql) && /status\s*=\s*'accepted'/i.test(sql));
  assert.ok(acceptSelected, "Expected selected quotation acceptance");

  // 3. Updated service_requests with accepted quote & expert & assigned status
  const updateSr = executed.find(({ sql }) => /UPDATE\s+service_requests/i.test(sql));
  assert.ok(updateSr, "Expected service_requests update with assigned status");
  assert.match(updateSr.sql, /status = 'assigned'/);

  // 4. Inserted request_expert_assignments
  const insertAssignment = executed.find(({ sql }) => /INSERT INTO\s+request_expert_assignments/i.test(sql));
  assert.ok(insertAssignment, "Expected request_expert_assignments insertion");

  // 5. Advanced inspection_workflows to surveyor stage
  const updateWf = executed.find(({ sql }) => /UPDATE\s+inspection_workflows/i.test(sql) && /surveyor/i.test(sql));
  assert.ok(updateWf, "Expected inspection_workflows advance to surveyor stage");
});

test("Direct acceptance via acceptQuotation is blocked with 409 CLIENT_APPROVAL_REQUIRED", async () => {
  const req = { params: { id: 50 }, user: { id: 1, role_id: 1 }, body: {} };
  const res = mockResponse();
  await acceptQuotation(req, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "CLIENT_APPROVAL_REQUIRED");
});

test("confirmWorkflowQuotation blocks advancement to surveyor stage if proposal is not approved", async () => {
  const originalConnect = pool.connect;
  pool.connect = async () => ({
    async query(sql) {
      const s = sql.toUpperCase();
      if (s.includes("FROM INSPECTION_WORKFLOWS WHERE SERVICE_REQUEST_ID")) {
        return { rows: [{ id: 1, service_request_id: 7, current_stage: "confirm", selected_quotation_id: 50 }] };
      }
      if (s.includes("FROM COMMERCIAL_PROPOSALS") && s.includes("STATUS = 'APPROVED'")) {
        return { rows: [] }; // NOT approved
      }
      if (s.includes("FROM SERVICE_REQUESTS WHERE ID")) {
        return { rows: [{ accepted_quotation_id: null, accepted_expert_id: null }] };
      }
      return { rows: [] };
    },
    release() {},
  });

  try {
    await assert.rejects(
      async () => {
        await confirmWorkflowQuotation({ requestId: 7, adminMarkupUsd: 500, actorUserId: 1 });
      },
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, "CLIENT_APPROVAL_REQUIRED");
        return true;
      }
    );
  } finally {
    pool.connect = originalConnect;
  }
});
