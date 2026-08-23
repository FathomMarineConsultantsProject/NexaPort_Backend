import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pool } from "../src/config/db.js";
import { approveInvoice, completeInspection, payInvoice, rejectInvoice, submitInvoice, validateInvoiceRejection, validateInvoiceSubmission, validatePaymentRecord } from "../src/services/inspectionInvoiceService.js";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("invoice and payment validation keeps financial milestones explicit", () => {
  assert.deepEqual(validateInvoiceSubmission({ invoiceNumber: " INV-42 ", amountUsd: "1550.257", dueDate: "2026-09-30" }), { invoiceNumber: "INV-42", amountUsd: 1550.26, currency: "USD", dueDate: "2026-09-30", internalNote: null });
  assert.throws(() => validateInvoiceSubmission({ invoiceNumber: "", amountUsd: 1 }), /Invoice number/);
  assert.throws(() => validateInvoiceSubmission({ invoiceNumber: "INV-1", amountUsd: 0 }), /positive USD/);
  assert.throws(() => validateInvoiceSubmission({ invoiceNumber: "INV-1", amountUsd: 1, currency: "EUR" }), /currency must be USD/);
  assert.deepEqual(validateInvoiceRejection({ rejectionReason: " Correct tax detail " }), { rejectionReason: "Correct tax detail" });
  assert.throws(() => validateInvoiceRejection({ rejectionReason: " " }), /rejection reason is required/i);
  assert.deepEqual(validatePaymentRecord({ paidAmountUsd: "1550", paymentReference: " BANK-9 ", paidDate: "2026-10-01" }), { paidAmountUsd: 1550, paymentReference: "BANK-9", paidDate: "2026-10-01", paymentNotes: null });
  assert.throws(() => validatePaymentRecord({ paidAmountUsd: 1550, paidDate: "2026-10-01" }), /reference/);
  assert.throws(() => validatePaymentRecord({ paidAmountUsd: 1550, paymentReference: "BANK-9" }), /valid date/);
});

test("invoice migration creates one constrained lifecycle record per workflow", async () => {
  const migration = await source("../sql/inspection_workflows_003_invoices.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.inspection_invoices/);
  assert.match(migration, /workflow_id BIGINT NOT NULL UNIQUE/);
  assert.match(migration, /invoice_number VARCHAR\(80\) NOT NULL/);
  assert.match(migration, /UNIQUE INDEX.*invoice_number_ci_uidx[\s\S]*LOWER\(invoice_number\)/);
  assert.match(migration, /CHECK \(status IN \('submitted', 'rejected', 'approved', 'paid'\)\)/);
  for (const field of ["completed_by_user_id", "currency CHAR(3)", "submitted_by_user_id", "submission_count", "rejection_reason", "paid_by_user_id"]) assert.match(migration, new RegExp(field.replace(/[()]/g, "\\$&")));
  assert.match(migration, /paid_amount_usd NUMERIC\(12,2\)/);
  assert.equal((migration.match(/CREATE TABLE/gi) || []).length, 1);
});

test("inspection completion is transactional and requires confirmed report proof", async () => {
  const service = await source("../src/services/inspectionInvoiceService.js");
  assert.match(service, /confirmed_at.*confirmed_by_user_id.*final_pdf_s3_key/s);
  assert.match(service, /current_stage='inspection_completed'/);
  assert.match(service, /UPDATE service_requests SET status='completed'/);
  assert.match(service, /inspection_workflow\.inspection_completed/);
  assert.match(service, /ROLLBACK/);
});

test("invoice lifecycle is idempotent, stage-guarded, audited, and financially isolated", async () => {
  const service = await source("../src/services/inspectionInvoiceService.js");
  assert.match(service, /INVOICE_EXISTS/);
  assert.match(service, /current_stage='invoice_submitted'/);
  assert.match(service, /status='approved'.*approved_by_user_id/s);
  assert.match(service, /current_stage='invoice_approved'/);
  assert.match(service, /status='rejected'.*rejection_reason/s);
  assert.match(service, /submission_count=submission_count\+1/);
  assert.match(service, /status='paid'.*paid_amount_usd/s);
  assert.match(service, /PAYMENT_AMOUNT_MISMATCH/);
  assert.match(service, /current_stage='invoice_paid'/);
  for (const event of ["invoice_submitted", "invoice_rejected", "invoice_approved", "invoice_paid"]) assert.match(service, new RegExp(`inspection_workflow\\.${event}`));
  assert.doesNotMatch(service, /UPDATE quotations/);
  assert.doesNotMatch(service, /approved_budget_usd\s*=/);
});

test("historic completed requests are not fabricated into paid workflows", async () => {
  const service = await source("../src/services/inspectionInvoiceService.js");
  const completion = service.slice(service.indexOf("export const completeInspection"), service.indexOf("export const createInvoiceUpload"));
  assert.doesNotMatch(completion, /INSERT INTO inspection_invoices|current_stage='invoice_paid'/);
  assert.match(service, /approved invoice is required before recording payment/i);
});

test("Phase 3 routes inherit Super Admin-only workflow security", async () => {
  const routes = await source("../src/routes/inspectionWorkflowRoutes.js");
  assert.match(routes, /router\.use\(requireAuth,allowRoles\(1\)\)/);
  for (const route of ["/:requestId/complete", "/:requestId/invoice", "/:requestId/invoice/reject", "/:requestId/invoice/approve", "/:requestId/invoice/pay"]) assert.match(routes, new RegExp(route.replaceAll("/", "\\/")));
});

test("Admin dashboard groups real workflow action counts and recent rows", async () => {
  const dashboard = await source("../src/controllers/dashboardController.js");
  for (const field of ["awaiting_quotation_review", "inspection_in_progress", "report_awaiting_review", "report_awaiting_confirmation", "inspection_awaiting_completion", "invoice_approval_required", "invoice_correction_required", "payment_pending"]) assert.match(dashboard, new RegExp(field));
  assert.match(dashboard, /inspection_workflow:/);
});

test("one inspection traverses confirmation, completion, rejection, resubmission, approval, and Paid", async () => {
  const originalConnect = pool.connect;
  const state = {
    workflow: { id: 71, service_request_id: 9, current_stage: "report_confirmation", report_id: 81, request_status: "active", accepted_quotation_id: 12, completed_at: null, completed_by_user_id: null },
    report: { id: 81, confirmed_at: null, confirmed_by_user_id: null, final_pdf_s3_key: null },
    invoice: null,
  };
  const client = {
    release() {},
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [], rowCount: 0 };
      if (normalized.startsWith("SELECT iw.*, sr.status AS request_status")) return { rows: [{ ...state.workflow }] };
      if (normalized.startsWith("SELECT id, confirmed_at")) return { rows: [{ ...state.report }] };
      if (normalized.startsWith("SELECT ii.*")) return { rows: state.invoice ? [{ ...state.invoice }] : [] };
      if (normalized.startsWith("SELECT id FROM inspection_invoices")) return { rows: [] };
      if (normalized.startsWith("UPDATE inspection_workflows SET current_stage='inspection_completed'")) {
        state.workflow.current_stage = "inspection_completed"; state.workflow.completed_at = new Date().toISOString(); state.workflow.completed_by_user_id = params[0]; return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE service_requests SET status='completed'")) { state.workflow.request_status = "completed"; return { rows: [], rowCount: 1 }; }
      if (normalized.startsWith("INSERT INTO inspection_invoices")) {
        state.invoice = { id: 91, service_request_id: params[0], workflow_id: params[1], invoice_number: params[2], amount_usd: params[3], currency: params[4], invoice_pdf_s3_key: params[5], due_date: params[6], internal_note: params[7], created_by_user_id: params[8], submitted_by_user_id: params[8], submitted_at: new Date().toISOString(), submission_count: 1, status: "submitted" };
        return { rows: [{ ...state.invoice }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE inspection_invoices SET invoice_number=")) {
        Object.assign(state.invoice, { invoice_number: params[0], amount_usd: params[1], currency: params[2], invoice_pdf_s3_key: params[3] || state.invoice.invoice_pdf_s3_key, due_date: params[4], internal_note: params[5], submitted_by_user_id: params[6], submitted_at: new Date().toISOString(), submission_count: state.invoice.submission_count + 1, status: "submitted", rejected_at: null, rejected_by_user_id: null, rejection_reason: null });
        return { rows: [{ ...state.invoice }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE inspection_invoices SET status='rejected'")) { Object.assign(state.invoice, { status: "rejected", rejected_at: new Date().toISOString(), rejected_by_user_id: params[0], rejection_reason: params[1] }); return { rows: [], rowCount: 1 }; }
      if (normalized.startsWith("UPDATE inspection_invoices SET status='approved'")) { Object.assign(state.invoice, { status: "approved", approved_at: new Date().toISOString(), approved_by_user_id: params[0] }); return { rows: [], rowCount: 1 }; }
      if (normalized.startsWith("UPDATE inspection_invoices SET status='paid'")) { Object.assign(state.invoice, { status: "paid", paid_amount_usd: params[0], payment_reference: params[1], paid_at: params[2], payment_notes: params[3], paid_by_user_id: params[4] }); return { rows: [], rowCount: 1 }; }
      if (normalized.startsWith("UPDATE inspection_workflows SET current_stage='invoice_submitted'")) { state.workflow.current_stage = "invoice_submitted"; return { rows: [], rowCount: 1 }; }
      if (normalized.startsWith("UPDATE inspection_workflows SET current_stage='invoice_approved'")) { state.workflow.current_stage = "invoice_approved"; return { rows: [], rowCount: 1 }; }
      if (normalized.startsWith("UPDATE inspection_workflows SET current_stage='invoice_paid'")) { state.workflow.current_stage = "invoice_paid"; return { rows: [], rowCount: 1 }; }
      if (normalized.includes("INSERT INTO public.admin_audit_logs") || normalized.includes("INSERT INTO public.admin_notifications")) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected test SQL: ${normalized}`);
    },
  };
  pool.connect = async () => client;
  try {
    await assert.rejects(completeInspection({ requestId: 9, actorUserId: 1 }), (error) => error.code === "CONFIRMED_REPORT_REQUIRED");
    Object.assign(state.report, { confirmed_at: new Date().toISOString(), confirmed_by_user_id: 2, final_pdf_s3_key: "reports/81.pdf" });
    await completeInspection({ requestId: 9, actorUserId: 3 });
    assert.equal(state.workflow.completed_by_user_id, 3);

    await submitInvoice({ requestId: 9, actorUserId: 4, data: { invoiceNumber: "INV-9", amountUsd: 1250, currency: "USD" } });
    assert.equal(state.workflow.current_stage, "invoice_submitted");
    assert.equal(state.invoice.submitted_by_user_id, 4);
    await assert.rejects(payInvoice({ requestId: 9, actorUserId: 5, data: { paidAmountUsd: 1250, paymentReference: "BANK-1", paidDate: "2026-08-23" } }), (error) => error.code === "APPROVED_INVOICE_REQUIRED");

    await rejectInvoice({ requestId: 9, actorUserId: 6, data: { rejectionReason: "Correct the reference" } });
    assert.equal(state.invoice.status, "rejected");
    await submitInvoice({ requestId: 9, actorUserId: 4, data: { invoiceNumber: "INV-9-R1", amountUsd: 1250, currency: "USD" } });
    assert.equal(state.invoice.submission_count, 2);
    assert.equal(state.invoice.rejection_reason, null);

    await approveInvoice({ requestId: 9, actorUserId: 7 });
    assert.equal(state.workflow.current_stage, "invoice_approved");
    await payInvoice({ requestId: 9, actorUserId: 8, data: { paidAmountUsd: 1250, paymentReference: "BANK-2", paidDate: "2026-08-23" } });
    assert.equal(state.workflow.current_stage, "invoice_paid");
    assert.equal(state.invoice.paid_by_user_id, 8);
    assert.equal(state.invoice.payment_reference, "BANK-2");
  } finally {
    pool.connect = originalConnect;
  }
});
