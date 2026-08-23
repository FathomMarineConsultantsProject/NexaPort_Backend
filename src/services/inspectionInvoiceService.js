import crypto from "node:crypto";
import { pool } from "../config/db.js";
import { createPresignedGetUrl, createPresignedPutUrl } from "../utils/s3Presign.js";
import { writeAdminAudit } from "./adminAuditService.js";
import { createInspectionWorkflowNotification } from "./adminNotificationService.js";

const workflowError = (status, code, message) => Object.assign(new Error(message), { status, code });
const positiveId = (value, name = "id") => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw workflowError(400, "INVALID_ID", `${name} must be a positive integer`);
  return parsed;
};
const clean = (value, max) => String(value ?? "").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, max);
const amount = (value, field) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 9999999999.99) throw workflowError(400, `INVALID_${field.toUpperCase()}`, `${field.replaceAll("_", " ")} must be a positive USD amount`);
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
};
const optionalDate = (value, required = false) => {
  if (!value && !required) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw workflowError(400, "INVALID_DATE", "Enter a valid date");
  return String(value);
};

export const validateInvoiceSubmission = (data = {}) => {
  const invoiceNumber = clean(data.invoiceNumber, 80);
  if (!invoiceNumber) throw workflowError(400, "INVOICE_NUMBER_REQUIRED", "Invoice number is required");
  const currency = clean(data.currency || "USD", 3).toUpperCase();
  if (currency !== "USD") throw workflowError(400, "UNSUPPORTED_INVOICE_CURRENCY", "Invoice currency must be USD");
  return {
    invoiceNumber,
    amountUsd: amount(data.amountUsd, "invoice_amount"),
    currency,
    dueDate: optionalDate(data.dueDate),
    internalNote: clean(data.internalNote, 2000) || null,
  };
};

export const validateInvoiceRejection = (data = {}) => {
  const rejectionReason = clean(data.rejectionReason, 2000);
  if (!rejectionReason) throw workflowError(400, "REJECTION_REASON_REQUIRED", "A rejection reason is required");
  return { rejectionReason };
};

export const validatePaymentRecord = (data = {}) => {
  const paymentReference = clean(data.paymentReference, 120);
  if (!paymentReference) throw workflowError(400, "PAYMENT_REFERENCE_REQUIRED", "Payment reference is required");
  return {
    paidAmountUsd: amount(data.paidAmountUsd, "paid_amount"),
    paymentReference,
    paidDate: optionalDate(data.paidDate, true),
    paymentNotes: clean(data.paymentNotes, 2000) || null,
  };
};

const lockWorkflow = async (client, requestId) => {
  const result = await client.query(
    `SELECT iw.*, sr.status AS request_status, sr.accepted_quotation_id
       FROM inspection_workflows iw
       JOIN service_requests sr ON sr.id=iw.service_request_id
      WHERE iw.service_request_id=$1
      FOR UPDATE OF iw, sr`,
    [requestId],
  );
  if (!result.rows[0]) throw workflowError(404, "WORKFLOW_NOT_FOUND", "Initialize the workflow first");
  return result.rows[0];
};

const invoiceForWorkflow = async (queryable, workflowId, lock = false) => {
  const result = await queryable.query(
    `SELECT ii.*,
       submitter.full_name AS submitted_by_name,
       approver.full_name AS approved_by_name,
       rejector.full_name AS rejected_by_name,
       payer.full_name AS paid_by_name
       FROM inspection_invoices ii
       LEFT JOIN users submitter ON submitter.id=ii.submitted_by_user_id
       LEFT JOIN users approver ON approver.id=ii.approved_by_user_id
       LEFT JOIN users rejector ON rejector.id=ii.rejected_by_user_id
       LEFT JOIN users payer ON payer.id=ii.paid_by_user_id
      WHERE ii.workflow_id=$1${lock ? " FOR UPDATE OF ii" : ""}`,
    [workflowId],
  );
  return result.rows[0] || null;
};

const mapInvoice = (row) => {
  if (!row) return null;
  let documentUrl = null;
  if (row.invoice_pdf_s3_key) {
    try { documentUrl = createPresignedGetUrl({ key: row.invoice_pdf_s3_key, expiresInSeconds: 300 }).url; } catch {}
  }
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    amountUsd: Number(row.amount_usd),
    currency: row.currency,
    dueDate: row.due_date,
    status: row.status,
    internalNote: row.internal_note,
    submittedAt: row.submitted_at,
    submittedBy: row.submitted_by_user_id ? { id: row.submitted_by_user_id, name: row.submitted_by_name } : null,
    submissionCount: Number(row.submission_count || 1),
    rejectedAt: row.rejected_at,
    rejectedBy: row.rejected_by_user_id ? { id: row.rejected_by_user_id, name: row.rejected_by_name } : null,
    rejectionReason: row.rejection_reason,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by_user_id ? { id: row.approved_by_user_id, name: row.approved_by_name } : null,
    paidAt: row.paid_at,
    paidAmountUsd: row.paid_amount_usd == null ? null : Number(row.paid_amount_usd),
    paymentReference: row.payment_reference,
    paymentNotes: row.payment_notes,
    paidBy: row.paid_by_user_id ? { id: row.paid_by_user_id, name: row.paid_by_name } : null,
    hasInvoiceDocument: Boolean(row.invoice_pdf_s3_key),
    documentUrl,
  };
};

export const getInvoiceWorkflowState = async (requestIdValue, queryable = pool) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const workflow = (await queryable.query("SELECT iw.*, u.full_name AS completed_by_name FROM inspection_workflows iw LEFT JOIN users u ON u.id=iw.completed_by_user_id WHERE iw.service_request_id=$1", [requestId])).rows[0];
  if (!workflow) return { inspectionCompletion: { completed: false, completedAt: null }, invoice: null };
  const invoice = await invoiceForWorkflow(queryable, workflow.id);
  return {
    inspectionCompletion: { completed: Boolean(workflow.completed_at), completedAt: workflow.completed_at, completedBy: workflow.completed_by_user_id ? { id: workflow.completed_by_user_id, name: workflow.completed_by_name } : null },
    invoice: mapInvoice(invoice),
  };
};

export const completeInspection = async ({ requestId: requestIdValue, actorUserId }) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workflow = await lockWorkflow(client, requestId);
    if (workflow.current_stage === "inspection_completed" && String(workflow.request_status).toLowerCase() === "completed") {
      await client.query("COMMIT");
      return;
    }
    if (workflow.current_stage !== "report_confirmation") throw workflowError(409, "INVALID_TRANSITION", "Workflow is not at Report Confirmation");
    const report = (await client.query(
      `SELECT id, confirmed_at, confirmed_by_user_id, final_pdf_s3_key
         FROM inspection_reports
        WHERE id=$1 AND service_request_id=$2
        FOR UPDATE`,
      [workflow.report_id, requestId],
    )).rows[0];
    if (!report?.confirmed_at || !report.confirmed_by_user_id || !report.final_pdf_s3_key) throw workflowError(409, "CONFIRMED_REPORT_REQUIRED", "A confirmed final report is required before completing the inspection");
    await client.query("UPDATE inspection_workflows SET current_stage='inspection_completed',completed_at=COALESCE(completed_at,CURRENT_TIMESTAMP),completed_by_user_id=COALESCE(completed_by_user_id,$1),updated_at=CURRENT_TIMESTAMP WHERE id=$2", [actorUserId, workflow.id]);
    await client.query("UPDATE service_requests SET status='completed',updated_at=CURRENT_TIMESTAMP WHERE id=$1", [requestId]);
    await writeAdminAudit(client, { actorUserId, action: "inspection_workflow.inspection_completed", targetType: "inspection_workflow", targetId: workflow.id, summary: `Completed inspection for request ${requestId} with final report ${report.id}` });
    await createInspectionWorkflowNotification(client, { actorUserId, requestId, workflowId: workflow.id, type: "inspection_completed", title: "Inspection completed", message: `Inspection request #${requestId} is ready for invoice submission.` });
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally { client.release(); }
};

export const createInvoiceUpload = async ({ requestId: requestIdValue, contentType, size }) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const byteSize = Number(size);
  if (contentType !== "application/pdf" || !Number.isFinite(byteSize) || byteSize <= 0 || byteSize > 10 * 1024 * 1024) throw workflowError(400, "INVALID_INVOICE_DOCUMENT", "Invoice document must be a PDF no larger than 10 MB");
  const workflow = (await pool.query("SELECT * FROM inspection_workflows WHERE service_request_id=$1", [requestId])).rows[0];
  if (!workflow || !["inspection_completed", "invoice_submitted"].includes(workflow.current_stage)) throw workflowError(409, "INVOICE_UNAVAILABLE", "Complete the inspection before uploading an invoice document");
  const currentInvoice = await invoiceForWorkflow(pool, workflow.id);
  if (currentInvoice && currentInvoice.status !== "rejected") throw workflowError(409, "INVOICE_LOCKED", "The invoice has already been submitted");
  const objectKey = `inspection-invoices/workflows/${workflow.id}/${crypto.randomUUID()}.pdf`;
  return { objectKey, uploadUrl: createPresignedPutUrl({ key: objectKey, contentType: "application/pdf", expiresIn: 300 }) };
};

export const submitInvoice = async ({ requestId: requestIdValue, actorUserId, data = {} }) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const { invoiceNumber, amountUsd, currency, dueDate, internalNote } = validateInvoiceSubmission(data);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workflow = await lockWorkflow(client, requestId);
    let invoice = await invoiceForWorkflow(client, workflow.id, true);
    if (invoice) {
      const same = invoice.invoice_number === invoiceNumber && Number(invoice.amount_usd) === amountUsd;
      if (same && invoice.status === "submitted" && workflow.current_stage === "invoice_submitted") { await client.query("COMMIT"); return invoice.id; }
      if (invoice.status !== "rejected" || workflow.current_stage !== "invoice_submitted") throw workflowError(409, "INVOICE_EXISTS", "An invoice has already been submitted for this workflow");
    }
    if (!["inspection_completed", "invoice_submitted"].includes(workflow.current_stage) || String(workflow.request_status).toLowerCase() !== "completed") throw workflowError(409, "INSPECTION_NOT_COMPLETED", "Complete the inspection before submitting an invoice");
    const duplicate = await client.query("SELECT id FROM inspection_invoices WHERE LOWER(invoice_number)=LOWER($1) AND workflow_id<>$2", [invoiceNumber, workflow.id]);
    if (duplicate.rows.length) throw workflowError(409, "DUPLICATE_INVOICE_NUMBER", "Invoice number is already in use");
    const objectKey = data.objectKey ? String(data.objectKey) : null;
    const prefix = `inspection-invoices/workflows/${workflow.id}/`;
    if (objectKey && (!objectKey.startsWith(prefix) || !objectKey.endsWith(".pdf") || objectKey.includes(".."))) throw workflowError(400, "INVALID_INVOICE_DOCUMENT", "Invoice document key is invalid");
    if (invoice) {
      invoice = (await client.query(
        `UPDATE inspection_invoices SET invoice_number=$1,amount_usd=$2,currency=$3,invoice_pdf_s3_key=COALESCE($4,invoice_pdf_s3_key),due_date=$5,internal_note=$6,status='submitted',submitted_at=CURRENT_TIMESTAMP,submitted_by_user_id=$7,submission_count=submission_count+1,rejected_at=NULL,rejected_by_user_id=NULL,rejection_reason=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$8 RETURNING *`,
        [invoiceNumber, amountUsd, currency, objectKey, dueDate, internalNote, actorUserId, invoice.id],
      )).rows[0];
    } else {
      invoice = (await client.query(
        `INSERT INTO inspection_invoices(service_request_id,workflow_id,invoice_number,amount_usd,currency,invoice_pdf_s3_key,due_date,internal_note,created_by_user_id,submitted_by_user_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
        [requestId, workflow.id, invoiceNumber, amountUsd, currency, objectKey, dueDate, internalNote, actorUserId],
      )).rows[0];
    }
    await client.query("UPDATE inspection_workflows SET current_stage='invoice_submitted',updated_at=CURRENT_TIMESTAMP WHERE id=$1", [workflow.id]);
    await writeAdminAudit(client, { actorUserId, action: "inspection_workflow.invoice_submitted", targetType: "inspection_workflow", targetId: workflow.id, summary: `Submitted invoice ${invoice.id} (${invoiceNumber}) for USD ${amountUsd.toFixed(2)}` });
    await createInspectionWorkflowNotification(client, { actorUserId, requestId, workflowId: workflow.id, type: `invoice_submitted_${invoice.submission_count || 1}`, title: "Invoice awaiting approval", message: `Invoice ${invoiceNumber} for USD ${amountUsd.toFixed(2)} requires review.`, payload: { invoice_id: invoice.id } });
    await client.query("COMMIT");
    return invoice.id;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally { client.release(); }
};

export const rejectInvoice = async ({ requestId: requestIdValue, actorUserId, data = {} }) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const { rejectionReason } = validateInvoiceRejection(data);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workflow = await lockWorkflow(client, requestId);
    const invoice = await invoiceForWorkflow(client, workflow.id, true);
    if (!invoice || invoice.status !== "submitted" || workflow.current_stage !== "invoice_submitted") throw workflowError(409, "SUBMITTED_INVOICE_REQUIRED", "A submitted invoice is required before rejection");
    await client.query("UPDATE inspection_invoices SET status='rejected',rejected_at=CURRENT_TIMESTAMP,rejected_by_user_id=$1,rejection_reason=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$3", [actorUserId, rejectionReason, invoice.id]);
    await writeAdminAudit(client, { actorUserId, action: "inspection_workflow.invoice_rejected", targetType: "inspection_workflow", targetId: workflow.id, summary: `Rejected invoice ${invoice.id}`, reason: rejectionReason });
    await createInspectionWorkflowNotification(client, { actorUserId, requestId, workflowId: workflow.id, type: `invoice_rejected_${invoice.submission_count || 1}`, title: "Invoice correction required", message: `Invoice ${invoice.invoice_number} was rejected and can be corrected and resubmitted.`, payload: { invoice_id: invoice.id, rejection_reason: rejectionReason } });
    await client.query("COMMIT");
  } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; } finally { client.release(); }
};

export const approveInvoice = async ({ requestId: requestIdValue, actorUserId }) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workflow = await lockWorkflow(client, requestId);
    const invoice = await invoiceForWorkflow(client, workflow.id, true);
    if (invoice?.status === "approved" && workflow.current_stage === "invoice_approved") { await client.query("COMMIT"); return; }
    if (!invoice || invoice.status !== "submitted" || workflow.current_stage !== "invoice_submitted") throw workflowError(409, "SUBMITTED_INVOICE_REQUIRED", "A submitted invoice is required before approval");
    await client.query("UPDATE inspection_invoices SET status='approved',approved_at=CURRENT_TIMESTAMP,approved_by_user_id=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2", [actorUserId, invoice.id]);
    await client.query("UPDATE inspection_workflows SET current_stage='invoice_approved',updated_at=CURRENT_TIMESTAMP WHERE id=$1", [workflow.id]);
    await writeAdminAudit(client, { actorUserId, action: "inspection_workflow.invoice_approved", targetType: "inspection_workflow", targetId: workflow.id, summary: `Approved invoice ${invoice.id} for USD ${Number(invoice.amount_usd).toFixed(2)}` });
    await createInspectionWorkflowNotification(client, { actorUserId, requestId, workflowId: workflow.id, type: "invoice_approved", title: "Invoice approved", message: `Invoice ${invoice.invoice_number} is approved and awaiting payment.`, payload: { invoice_id: invoice.id } });
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally { client.release(); }
};

export const payInvoice = async ({ requestId: requestIdValue, actorUserId, data = {} }) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const { paidAmountUsd, paymentReference, paidDate, paymentNotes } = validatePaymentRecord(data);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workflow = await lockWorkflow(client, requestId);
    const invoice = await invoiceForWorkflow(client, workflow.id, true);
    if (invoice?.status === "paid" && workflow.current_stage === "invoice_paid") { await client.query("COMMIT"); return; }
    if (!invoice || invoice.status !== "approved" || workflow.current_stage !== "invoice_approved") throw workflowError(409, "APPROVED_INVOICE_REQUIRED", "An approved invoice is required before recording payment");
    if (paidAmountUsd !== Number(invoice.amount_usd)) throw workflowError(409, "PAYMENT_AMOUNT_MISMATCH", "Paid amount must equal the approved invoice amount before marking it Paid");
    await client.query(
      "UPDATE inspection_invoices SET status='paid',paid_amount_usd=$1,payment_reference=$2,paid_at=$3::date,payment_notes=$4,paid_by_user_id=$5,updated_at=CURRENT_TIMESTAMP WHERE id=$6",
      [paidAmountUsd, paymentReference, paidDate, paymentNotes, actorUserId, invoice.id],
    );
    await client.query("UPDATE inspection_workflows SET current_stage='invoice_paid',updated_at=CURRENT_TIMESTAMP WHERE id=$1", [workflow.id]);
    await writeAdminAudit(client, { actorUserId, action: "inspection_workflow.invoice_paid", targetType: "inspection_workflow", targetId: workflow.id, summary: `Recorded payment for invoice ${invoice.id}: USD ${paidAmountUsd.toFixed(2)}` });
    await createInspectionWorkflowNotification(client, { actorUserId, requestId, workflowId: workflow.id, type: "invoice_paid", title: "Inspection lifecycle paid", message: `Payment for invoice ${invoice.invoice_number} was recorded. The commercial workflow is complete.`, payload: { invoice_id: invoice.id, payment_reference: paymentReference } });
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally { client.release(); }
};
