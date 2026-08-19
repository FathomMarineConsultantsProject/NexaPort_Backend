import crypto from "node:crypto";
import { pool } from "../config/db.js";
import { createPresignedGetUrl, createPresignedPutUrl } from "../utils/s3Presign.js";
import { writeAdminAudit } from "./adminAuditService.js";

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
  return {
    invoiceNumber,
    amountUsd: amount(data.amountUsd, "invoice_amount"),
    dueDate: optionalDate(data.dueDate),
    internalNote: clean(data.internalNote, 2000) || null,
  };
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
    `SELECT * FROM inspection_invoices WHERE workflow_id=$1${lock ? " FOR UPDATE" : ""}`,
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
    dueDate: row.due_date,
    status: row.status,
    internalNote: row.internal_note,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    approvedByUserId: row.approved_by_user_id,
    paidAt: row.paid_at,
    paidAmountUsd: row.paid_amount_usd == null ? null : Number(row.paid_amount_usd),
    paymentReference: row.payment_reference,
    paymentNotes: row.payment_notes,
    hasInvoiceDocument: Boolean(row.invoice_pdf_s3_key),
    documentUrl,
  };
};

export const getInvoiceWorkflowState = async (requestIdValue, queryable = pool) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const workflow = (await queryable.query("SELECT * FROM inspection_workflows WHERE service_request_id=$1", [requestId])).rows[0];
  if (!workflow) return { inspectionCompletion: { completed: false, completedAt: null }, invoice: null };
  const invoice = await invoiceForWorkflow(queryable, workflow.id);
  return {
    inspectionCompletion: { completed: Boolean(workflow.completed_at), completedAt: workflow.completed_at },
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
    await client.query("UPDATE inspection_workflows SET current_stage='inspection_completed',completed_at=COALESCE(completed_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=$1", [workflow.id]);
    await client.query("UPDATE service_requests SET status='completed',updated_at=CURRENT_TIMESTAMP WHERE id=$1", [requestId]);
    await writeAdminAudit(client, { actorUserId, action: "inspection_workflow.inspection_completed", targetType: "inspection_workflow", targetId: workflow.id, summary: `Completed inspection for request ${requestId} with final report ${report.id}` });
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
  if (!workflow || workflow.current_stage !== "inspection_completed") throw workflowError(409, "INVOICE_UNAVAILABLE", "Complete the inspection before uploading an invoice document");
  if (await invoiceForWorkflow(pool, workflow.id)) throw workflowError(409, "INVOICE_LOCKED", "The invoice has already been submitted");
  const objectKey = `inspection-invoices/workflows/${workflow.id}/${crypto.randomUUID()}.pdf`;
  return { objectKey, uploadUrl: createPresignedPutUrl({ key: objectKey, contentType: "application/pdf", expiresIn: 300 }) };
};

export const submitInvoice = async ({ requestId: requestIdValue, actorUserId, data = {} }) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const { invoiceNumber, amountUsd, dueDate, internalNote } = validateInvoiceSubmission(data);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workflow = await lockWorkflow(client, requestId);
    let invoice = await invoiceForWorkflow(client, workflow.id, true);
    if (invoice) {
      const same = invoice.invoice_number === invoiceNumber && Number(invoice.amount_usd) === amountUsd;
      if (same && workflow.current_stage === "invoice_submitted") { await client.query("COMMIT"); return invoice.id; }
      throw workflowError(409, "INVOICE_EXISTS", "An invoice has already been submitted for this workflow");
    }
    if (workflow.current_stage !== "inspection_completed" || String(workflow.request_status).toLowerCase() !== "completed") throw workflowError(409, "INSPECTION_NOT_COMPLETED", "Complete the inspection before submitting an invoice");
    const duplicate = await client.query("SELECT id FROM inspection_invoices WHERE LOWER(invoice_number)=LOWER($1)", [invoiceNumber]);
    if (duplicate.rows.length) throw workflowError(409, "DUPLICATE_INVOICE_NUMBER", "Invoice number is already in use");
    const objectKey = data.objectKey ? String(data.objectKey) : null;
    const prefix = `inspection-invoices/workflows/${workflow.id}/`;
    if (objectKey && (!objectKey.startsWith(prefix) || !objectKey.endsWith(".pdf") || objectKey.includes(".."))) throw workflowError(400, "INVALID_INVOICE_DOCUMENT", "Invoice document key is invalid");
    invoice = (await client.query(
      `INSERT INTO inspection_invoices(service_request_id,workflow_id,invoice_number,amount_usd,invoice_pdf_s3_key,due_date,internal_note,created_by_user_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [requestId, workflow.id, invoiceNumber, amountUsd, objectKey, dueDate, internalNote, actorUserId],
    )).rows[0];
    await client.query("UPDATE inspection_workflows SET current_stage='invoice_submitted',updated_at=CURRENT_TIMESTAMP WHERE id=$1", [workflow.id]);
    await writeAdminAudit(client, { actorUserId, action: "inspection_workflow.invoice_submitted", targetType: "inspection_workflow", targetId: workflow.id, summary: `Submitted invoice ${invoice.id} (${invoiceNumber}) for USD ${amountUsd.toFixed(2)}` });
    await client.query("COMMIT");
    return invoice.id;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally { client.release(); }
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
    await client.query(
      "UPDATE inspection_invoices SET status='paid',paid_amount_usd=$1,payment_reference=$2,paid_at=$3::date,payment_notes=$4,updated_at=CURRENT_TIMESTAMP WHERE id=$5",
      [paidAmountUsd, paymentReference, paidDate, paymentNotes, invoice.id],
    );
    await client.query("UPDATE inspection_workflows SET current_stage='invoice_paid',updated_at=CURRENT_TIMESTAMP WHERE id=$1", [workflow.id]);
    await writeAdminAudit(client, { actorUserId, action: "inspection_workflow.invoice_paid", targetType: "inspection_workflow", targetId: workflow.id, summary: `Recorded payment for invoice ${invoice.id}: USD ${paidAmountUsd.toFixed(2)}` });
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally { client.release(); }
};
