import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateInvoiceSubmission, validatePaymentRecord } from "../src/services/inspectionInvoiceService.js";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("invoice and payment validation keeps financial milestones explicit", () => {
  assert.deepEqual(validateInvoiceSubmission({ invoiceNumber: " INV-42 ", amountUsd: "1550.257", dueDate: "2026-09-30" }), { invoiceNumber: "INV-42", amountUsd: 1550.26, dueDate: "2026-09-30", internalNote: null });
  assert.throws(() => validateInvoiceSubmission({ invoiceNumber: "", amountUsd: 1 }), /Invoice number/);
  assert.throws(() => validateInvoiceSubmission({ invoiceNumber: "INV-1", amountUsd: 0 }), /positive USD/);
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
  assert.match(migration, /CHECK \(status IN \('submitted', 'approved', 'paid'\)\)/);
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
  assert.match(service, /status='paid'.*paid_amount_usd/s);
  assert.match(service, /current_stage='invoice_paid'/);
  for (const event of ["invoice_submitted", "invoice_approved", "invoice_paid"]) assert.match(service, new RegExp(`inspection_workflow\\.${event}`));
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
  for (const route of ["/:requestId/complete", "/:requestId/invoice", "/:requestId/invoice/approve", "/:requestId/invoice/pay"]) assert.match(routes, new RegExp(route.replaceAll("/", "\\/")));
});

test("Admin dashboard groups real workflow action counts and recent rows", async () => {
  const dashboard = await source("../src/controllers/dashboardController.js");
  for (const field of ["awaiting_quotation_review", "inspection_in_progress", "report_awaiting_review", "report_awaiting_confirmation", "inspection_awaiting_completion", "invoice_approval_required", "payment_pending"]) assert.match(dashboard, new RegExp(field));
  assert.match(dashboard, /inspection_workflow:/);
});
