import crypto from "node:crypto";
import { pool } from "../config/db.js";
import { createPresignedGetUrl, createPresignedPutUrl } from "../utils/s3Presign.js";
import { writeAdminAudit } from "./adminAuditService.js";
import { deletePrivateObject, readPrivateObject, writePrivateObject } from "./privateObjectService.js";
import { generateDailyReportPdf, prepareDailyReportImage } from "./dailyReportPdfService.js";

const EXECUTION_STAGES = Object.freeze([
  "preparation", "checklist", "report", "review", "report_confirmation",
  "inspection_completed", "invoice_submitted", "invoice_approved", "invoice_paid",
]);
const IMAGE_TYPES = Object.freeze({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" });
export const DEFAULT_CLOSING_STATEMENT = "Each identified deficiency was thoroughly reviewed and discussed with the ship's crew to ensure a clear understanding and to facilitate effective corrective measures. The crew has been instructed to prioritize rectification efforts based on the criticality of the deficiencies identified.";

const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const positiveId = (value, name = "id") => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw fail(400, "INVALID_ID", `${name} must be a positive integer`);
  return parsed;
};
const text = (value, max, fallback = "") => String(value ?? fallback).trim().slice(0, max);

export const toIsoDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const str = String(value).trim();
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) {
    const year = parsed.getUTCFullYear();
    const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
    const day = String(parsed.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return null;
};

const validDate = (value, name = "reportDate") => {
  const result = toIsoDate(value);
  if (!result) throw fail(400, "INVALID_DAILY_REPORT", `${name} must be a valid date`);
  return result;
};

const nextDate = (value) => {
  const iso = toIsoDate(value);
  if (!iso) {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  }
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + 1));
  return date.toISOString().slice(0, 10);
};
const serviceLabel = (row) => row.service_type === "Other" ? text(row.service_type_other, 500, "Other") : text(row.service_category || row.service_type, 500);
export const stageAllowsDailyReports = (stage) => EXECUTION_STAGES.includes(stage);
export const nextDailyReportNumber = (lastDayNumber = 0) => {
  const current = Number(lastDayNumber);
  if (!Number.isInteger(current) || current < 0) throw fail(400, "INVALID_DAILY_REPORT_SEQUENCE", "Daily Report sequence is invalid");
  return current + 1;
};

export const normalizeDailyReportData = (input = {}, defaults = {}) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail(400, "INVALID_DAILY_REPORT", "Daily Report data must be an object");
  const activitiesInput = input.activities === undefined ? (defaults.activities || []) : input.activities;
  if (!Array.isArray(activitiesInput) || activitiesInput.length > 100) throw fail(400, "INVALID_DAILY_REPORT", "Activities must contain no more than 100 rows");
  const activities = activitiesInput.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw fail(400, "INVALID_DAILY_REPORT", "Each activity must be a structured row");
    return { id: /^[a-zA-Z0-9_-]{1,80}$/.test(String(item.id || "")) ? String(item.id) : crypto.randomUUID(), description: text(item.description, 2000) };
  });
  const boardingTime = text(input.boardingTime, 5, defaults.boardingTime);
  if (boardingTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(boardingTime)) throw fail(400, "INVALID_DAILY_REPORT", "Boarding time must use HH:mm");
  const boardingDateValue = input.boardingDate ?? defaults.boardingDate;
  return {
    locationDetail: text(input.locationDetail, 500, defaults.locationDetail),
    inspectionScope: text(input.inspectionScope, 1000, defaults.inspectionScope),
    boardingTime,
    boardingDate: boardingDateValue ? validDate(boardingDateValue, "boardingDate") : "",
    boardingLocation: text(input.boardingLocation, 500, defaults.boardingLocation),
    activities,
    closingStatement: text(input.closingStatement, 2500, defaults.closingStatement),
  };
};

const getContext = async (queryable, requestId, { lock = false } = {}) => {
  const result = await queryable.query(
    `SELECT iw.id AS workflow_id,iw.current_stage,iw.service_request_id,
            sr.title,sr.service_type,sr.service_category,sr.service_type_other,sr.scope_of_work,sr.required_by,
            sr.vessel_name,sr.imo_number,sr.vessel_type,sr.flag_state,sr.port_name,sr.country,sr.location_summary,
            sr.requester_user_id,sr.requester_name,client.full_name AS client_user_name,client.email AS client_email,
            expert.id AS surveyor_id,expert.full_name AS surveyor_name
       FROM public.inspection_workflows iw
       JOIN public.service_requests sr ON sr.id=iw.service_request_id
       LEFT JOIN public.users client ON client.id=sr.requester_user_id
       LEFT JOIN public.quotations accepted_q ON accepted_q.id=sr.accepted_quotation_id
       LEFT JOIN public.experts expert ON expert.id=COALESCE(sr.accepted_expert_id,accepted_q.expert_id,
         (SELECT rea.expert_id FROM public.request_expert_assignments rea WHERE rea.service_request_id=sr.id ORDER BY rea.updated_at DESC NULLS LAST,rea.id DESC LIMIT 1))
      WHERE iw.service_request_id=$1${lock ? " FOR UPDATE OF iw" : ""}`,
    [requestId],
  );
  const row = result.rows[0];
  if (!row) throw fail(404, "WORKFLOW_NOT_FOUND", "Inspection workflow not found");
  return {
    workflow: { id: row.workflow_id, currentStage: row.current_stage, serviceRequestId: row.service_request_id },
    request: {
      id: row.service_request_id, reference: row.title || `Request #${row.service_request_id}`,
      service: serviceLabel(row), scope: row.scope_of_work, requiredBy: row.required_by,
      port: { name: row.port_name, country: row.country, locationSummary: row.location_summary },
    },
    vessel: { name: row.vessel_name, imoNumber: row.imo_number, type: row.vessel_type, flag: row.flag_state },
    client: { id: row.requester_user_id, name: row.requester_name || row.client_user_name, email: row.client_email },
    surveyor: row.surveyor_id ? { id: row.surveyor_id, name: row.surveyor_name } : null,
  };
};
const requireExecution = (context) => {
  if (!stageAllowsDailyReports(context.workflow.currentStage)) throw fail(409, "DAILY_REPORTS_UNAVAILABLE", "Daily Reports become available when inspection preparation begins");
  return context;
};
const snapshot = (context) => ({ request: context.request, vessel: context.vessel, client: context.client, surveyor: context.surveyor });
const defaultsFromContext = (context, reportDate) => ({
  locationDetail: [context.request.port?.name, context.request.port?.country, context.request.port?.locationSummary].filter(Boolean).join(", "),
  inspectionScope: context.request.scope || context.request.service,
  boardingDate: reportDate,
  boardingLocation: [context.request.port?.name, context.request.port?.country].filter(Boolean).join(", "),
  activities: [],
  closingStatement: DEFAULT_CLOSING_STATEMENT,
});
const safeUrl = (key) => {
  if (!key) return null;
  try { return createPresignedGetUrl({ key, expiresInSeconds: 300 }).url; } catch { return null; }
};
const preparedBy = (row) => ({ id: row.prepared_by_user_id, name: row.prepared_by_name, email: row.prepared_by_email });
const publicPhoto = (row) => ({
  id: row.id, caption: row.caption, inspectionArea: row.inspection_area, relatedActivityId: row.related_activity_id,
  sortOrder: row.sort_order, uploadedAt: row.uploaded_at, previewUrl: safeUrl(row.photo_s3_key),
});
const publicReport = (row, context, photos = []) => {
  const frozen = row.status === "final" && row.prefill_snapshot_jsonb && Object.keys(row.prefill_snapshot_jsonb).length ? row.prefill_snapshot_jsonb : snapshot(context);
  return {
    id: row.id, workflowId: row.workflow_id, serviceRequestId: row.service_request_id,
    dayNumber: row.day_number, reportDate: toIsoDate(row.report_date), status: String(row.status).toUpperCase(),
    data: row.data_jsonb || {}, prefills: frozen, preparedBy: preparedBy(row), photos,
    generatedAt: row.generated_at, downloadUrl: safeUrl(row.generated_pdf_s3_key),
    finalizedAt: row.finalized_at, createdAt: row.created_at, updatedAt: row.updated_at, locked: row.status === "final",
  };
};
const reportSelect = `SELECT dr.*,prepared.full_name AS prepared_by_name,prepared.email AS prepared_by_email
  FROM public.inspection_daily_reports dr JOIN public.users prepared ON prepared.id=dr.prepared_by_user_id`;
const fetchReport = async (queryable, context, dailyReportId, { lock = false } = {}) => {
  const result = await queryable.query(`${reportSelect} WHERE dr.id=$1 AND dr.workflow_id=$2${lock ? " FOR UPDATE OF dr" : ""}`, [dailyReportId, context.workflow.id]);
  if (!result.rows[0]) throw fail(404, "DAILY_REPORT_NOT_FOUND", "Daily Report not found");
  return result.rows[0];
};
const fetchPhotos = async (queryable, dailyReportId) => (await queryable.query(
  "SELECT * FROM public.inspection_daily_report_photos WHERE daily_report_id=$1 ORDER BY sort_order,id", [dailyReportId],
)).rows;

export const dailyReportFinalizationErrors = (report, context) => {
  const errors = [];
  const data = report.data_jsonb || report.data || {};
  if (!report.report_date && !report.reportDate) errors.push({ field: "reportDate", message: "Report date is required" });
  if (!text(context.vessel?.name, 200)) errors.push({ field: "vessel", message: "Vessel name is required" });
  if (!text(context.surveyor?.name, 200)) errors.push({ field: "inspector", message: "Assigned Inspector is required" });
  if (!text(data.locationDetail, 500)) errors.push({ field: "locationDetail", message: "Vessel location is required" });
  if (!text(data.inspectionScope, 1000)) errors.push({ field: "inspectionScope", message: "Scope of inspection is required" });
  if (!text(data.boardingTime, 5)) errors.push({ field: "boardingTime", message: "Boarding time is required" });
  if (!text(data.boardingDate, 10)) errors.push({ field: "boardingDate", message: "Boarding date is required" });
  if (!text(data.boardingLocation, 500)) errors.push({ field: "boardingLocation", message: "Boarding location is required" });
  if (!Array.isArray(data.activities) || !data.activities.some((item) => text(item?.description, 2000))) errors.push({ field: "activities", message: "Add at least one inspection activity" });
  return errors;
};

export const listDailyReports = async (requestIdValue) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const context = requireExecution(await getContext(pool, requestId));
  const rows = (await pool.query(`${reportSelect} WHERE dr.workflow_id=$1 ORDER BY dr.day_number,dr.id`, [context.workflow.id])).rows;
  return { available: true, workflowId: context.workflow.id, prefills: snapshot(context), reports: rows.map((row) => publicReport(row, context)) };
};

export const getDailyReport = async (requestIdValue, dailyReportIdValue) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const dailyReportId = positiveId(dailyReportIdValue, "dailyReportId");
  const context = requireExecution(await getContext(pool, requestId));
  const report = await fetchReport(pool, context, dailyReportId);
  const photos = await fetchPhotos(pool, report.id);
  return publicReport(report, context, photos.map(publicPhoto));
};

export const createDailyReport = async ({ requestId: requestIdValue, actorUserId, input = {} }) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const context = requireExecution(await getContext(client, requestId, { lock: true }));
    const sequence = (await client.query("SELECT COALESCE(MAX(day_number),0)::int AS day_number,MAX(report_date) AS report_date FROM public.inspection_daily_reports WHERE workflow_id=$1", [context.workflow.id])).rows[0];
    const dayNumber = nextDailyReportNumber(sequence.day_number);
    const fallbackDate = sequence.report_date ? nextDate(sequence.report_date) : toIsoDate(context.request.requiredBy) || toIsoDate(new Date());
    const reportDate = validDate(input.reportDate || fallbackDate);
    const data = normalizeDailyReportData(input.data || {}, defaultsFromContext(context, reportDate));
    const inserted = await client.query(
      `INSERT INTO public.inspection_daily_reports
       (workflow_id,service_request_id,report_date,day_number,status,data_jsonb,prepared_by_user_id)
       VALUES($1,$2,$3,$4,'draft',$5,$6) RETURNING id`,
      [context.workflow.id, requestId, reportDate, dayNumber, JSON.stringify(data), actorUserId],
    );
    await writeAdminAudit(client, { actorUserId, action: "daily_report.created", targetType: "inspection_daily_report", targetId: inserted.rows[0].id, summary: `Created Day ${dayNumber} Daily Report for request ${requestId}` });
    await client.query("COMMIT");
    return getDailyReport(requestId, inserted.rows[0].id);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    if (error.code === "23505") throw fail(409, "DAILY_REPORT_DATE_CONFLICT", "A Daily Report already exists for that date");
    throw error;
  } finally { client.release(); }
};

export const updateDailyReport = async ({ requestId: requestIdValue, dailyReportId: reportIdValue, actorUserId, input = {} }) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const dailyReportId = positiveId(reportIdValue, "dailyReportId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const context = requireExecution(await getContext(client, requestId, { lock: true }));
    const report = await fetchReport(client, context, dailyReportId, { lock: true });
    if (report.status === "final") throw fail(409, "DAILY_REPORT_FINAL", "Final Daily Reports are read-only");
    const reportDate = input.reportDate ? validDate(input.reportDate) : toIsoDate(report.report_date);
    const data = normalizeDailyReportData(input.data ?? report.data_jsonb, report.data_jsonb);
    await client.query("UPDATE public.inspection_daily_reports SET report_date=$1,data_jsonb=$2,generated_pdf_s3_key=NULL,generated_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$3", [reportDate, JSON.stringify(data), report.id]);
    await writeAdminAudit(client, { actorUserId, action: "daily_report.updated", targetType: "inspection_daily_report", targetId: report.id, summary: `Updated Day ${report.day_number} Daily Report` });
    await client.query("COMMIT");
    return getDailyReport(requestId, report.id);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    if (error.code === "23505") throw fail(409, "DAILY_REPORT_DATE_CONFLICT", "A Daily Report already exists for that date");
    throw error;
  } finally { client.release(); }
};

const materializePdf = async (report, context, photoRows, status) => {
  const effectiveContext = status === "final" ? snapshot(context) : context;
  const photos = [];
  for (const photo of photoRows) {
    const item = { caption: photo.caption, inspectionArea: photo.inspection_area, relatedActivityId: photo.related_activity_id };
    try {
      const sourceBytes = await readPrivateObject(photo.photo_s3_key, 8 * 1024 * 1024);
      photos.push({ ...item, preparedImage: await prepareDailyReportImage(sourceBytes) });
    } catch (error) {
      console.warn("Daily Report photograph unavailable during PDF generation", { photoId: photo.id, message: error.message });
      photos.push(item);
    }
  }
  return generateDailyReportPdf({
    report: { ...report, dayNumber: report.day_number, reportDate: toIsoDate(report.report_date || report.reportDate), data: report.data_jsonb, status, preparedBy: preparedBy(report) },
    context: effectiveContext, photos,
  });
};

export const generateDailyReport = async ({ requestId: requestIdValue, dailyReportId: reportIdValue, actorUserId }) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const dailyReportId = positiveId(reportIdValue, "dailyReportId");
  const context = requireExecution(await getContext(pool, requestId));
  const report = await fetchReport(pool, context, dailyReportId);
  if (report.status === "final" && report.generated_pdf_s3_key) return getDailyReport(requestId, report.id);
  const photos = await fetchPhotos(pool, report.id);
  const bytes = await materializePdf(report, context, photos, report.status);
  const key = `inspection-daily-reports/workflows/${context.workflow.id}/reports/${report.id}/generated/${report.status}-${crypto.randomUUID()}.pdf`;
  await writePrivateObject(key, "application/pdf", bytes);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await fetchReport(client, context, report.id, { lock: true });
    if (locked.status === "final" && report.status !== "final") throw fail(409, "DAILY_REPORT_FINAL", "Daily Report was finalized while the preview was being generated");
    if (String(locked.updated_at) !== String(report.updated_at)) throw fail(409, "DAILY_REPORT_CHANGED", "Daily Report changed while the PDF was being generated; generate it again");
    await client.query("UPDATE public.inspection_daily_reports SET generated_pdf_s3_key=$1,generated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$2", [key, report.id]);
    await writeAdminAudit(client, { actorUserId, action: "daily_report.generated", targetType: "inspection_daily_report", targetId: report.id, summary: `Generated Day ${report.day_number} Daily Report PDF` });
    await client.query("COMMIT");
  } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
  finally { client.release(); }
  return getDailyReport(requestId, report.id);
};

export const finalizeDailyReport = async ({ requestId: requestIdValue, dailyReportId: reportIdValue, actorUserId }) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const dailyReportId = positiveId(reportIdValue, "dailyReportId");
  const context = requireExecution(await getContext(pool, requestId));
  const report = await fetchReport(pool, context, dailyReportId);
  if (report.status === "final") return getDailyReport(requestId, report.id);
  const fieldErrors = dailyReportFinalizationErrors(report, context);
  if (fieldErrors.length) throw fail(400, "DAILY_REPORT_INCOMPLETE", "Complete the required Daily Report information before finalizing", { fieldErrors });
  const photos = await fetchPhotos(pool, report.id);
  const bytes = await materializePdf(report, context, photos, "final");
  const key = `inspection-daily-reports/workflows/${context.workflow.id}/reports/${report.id}/generated/final-${crypto.randomUUID()}.pdf`;
  await writePrivateObject(key, "application/pdf", bytes);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lockedContext = requireExecution(await getContext(client, requestId, { lock: true }));
    const locked = await fetchReport(client, lockedContext, report.id, { lock: true });
    if (locked.status === "final") { await client.query("COMMIT"); return getDailyReport(requestId, report.id); }
    if (String(locked.updated_at) !== String(report.updated_at)) throw fail(409, "DAILY_REPORT_CHANGED", "Daily Report changed while it was being finalized; review and finalize it again");
    await client.query(
      `UPDATE public.inspection_daily_reports SET status='final',prefill_snapshot_jsonb=$1,generated_pdf_s3_key=$2,
       generated_at=CURRENT_TIMESTAMP,finalized_at=CURRENT_TIMESTAMP,finalized_by_user_id=$3,updated_at=CURRENT_TIMESTAMP WHERE id=$4`,
      [JSON.stringify(snapshot(lockedContext)), key, actorUserId, report.id],
    );
    await writeAdminAudit(client, { actorUserId, action: "daily_report.generated", targetType: "inspection_daily_report", targetId: report.id, summary: `Generated final Day ${report.day_number} Daily Report PDF` });
    await writeAdminAudit(client, { actorUserId, action: "daily_report.finalized", targetType: "inspection_daily_report", targetId: report.id, summary: `Finalized Day ${report.day_number} Daily Report` });
    await client.query("COMMIT");
  } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
  finally { client.release(); }
  return getDailyReport(requestId, report.id);
};

export const createDailyReportPhotoUpload = async ({ requestId: requestIdValue, dailyReportId: reportIdValue, contentType, size }) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const dailyReportId = positiveId(reportIdValue, "dailyReportId");
  if (!IMAGE_TYPES[contentType] || !Number.isInteger(Number(size)) || Number(size) < 1 || Number(size) > 8 * 1024 * 1024) throw fail(400, "INVALID_DAILY_REPORT_PHOTO", "Use a JPEG, PNG, or WebP image up to 8 MB");
  const context = requireExecution(await getContext(pool, requestId));
  const report = await fetchReport(pool, context, dailyReportId);
  if (report.status === "final") throw fail(409, "DAILY_REPORT_FINAL", "Final Daily Reports are read-only");
  const uploadId = crypto.randomUUID();
  const objectKey = `inspection-daily-reports/workflows/${context.workflow.id}/reports/${report.id}/photos/${uploadId}.${IMAGE_TYPES[contentType]}`;
  return { uploadId, uploadUrl: createPresignedPutUrl({ key: objectKey, contentType, expiresIn: 300 }) };
};

export const attachDailyReportPhoto = async ({ requestId: requestIdValue, dailyReportId: reportIdValue, actorUserId, input = {} }) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const dailyReportId = positiveId(reportIdValue, "dailyReportId");
  if (!/^[0-9a-f-]{36}$/i.test(String(input.uploadId || "")) || !IMAGE_TYPES[input.contentType]) throw fail(400, "INVALID_DAILY_REPORT_PHOTO", "Photo upload reference is invalid");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const context = requireExecution(await getContext(client, requestId, { lock: true }));
    const report = await fetchReport(client, context, dailyReportId, { lock: true });
    if (report.status === "final") throw fail(409, "DAILY_REPORT_FINAL", "Final Daily Reports are read-only");
    const count = Number((await client.query("SELECT COUNT(*)::int AS count FROM public.inspection_daily_report_photos WHERE daily_report_id=$1", [report.id])).rows[0].count);
    if (count >= 20) throw fail(409, "DAILY_REPORT_PHOTO_LIMIT", "A Daily Report supports up to 20 photographs");
    const objectKey = `inspection-daily-reports/workflows/${context.workflow.id}/reports/${report.id}/photos/${input.uploadId}.${IMAGE_TYPES[input.contentType]}`;
    await client.query(
      `INSERT INTO public.inspection_daily_report_photos
       (daily_report_id,photo_s3_key,caption,inspection_area,related_activity_id,sort_order,uploaded_by_user_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [report.id, objectKey, text(input.caption, 240) || null, text(input.inspectionArea, 120) || null, text(input.relatedActivityId, 80) || null, count, actorUserId],
    );
    await client.query("UPDATE public.inspection_daily_reports SET generated_pdf_s3_key=NULL,generated_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1", [report.id]);
    await writeAdminAudit(client, { actorUserId, action: "daily_report.updated", targetType: "inspection_daily_report", targetId: report.id, summary: `Added photograph to Day ${report.day_number} Daily Report` });
    await client.query("COMMIT");
    return getDailyReport(requestId, report.id);
  } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
  finally { client.release(); }
};

export const removeDailyReportPhoto = async ({ requestId: requestIdValue, dailyReportId: reportIdValue, photoId: photoIdValue, actorUserId }) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const dailyReportId = positiveId(reportIdValue, "dailyReportId");
  const photoId = positiveId(photoIdValue, "photoId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const context = requireExecution(await getContext(client, requestId, { lock: true }));
    const report = await fetchReport(client, context, dailyReportId, { lock: true });
    if (report.status === "final") throw fail(409, "DAILY_REPORT_FINAL", "Final Daily Reports are read-only");
    const photo = (await client.query("SELECT * FROM public.inspection_daily_report_photos WHERE id=$1 AND daily_report_id=$2", [photoId, report.id])).rows[0];
    if (!photo) throw fail(404, "DAILY_REPORT_PHOTO_NOT_FOUND", "Daily Report photograph not found");
    await deletePrivateObject(photo.photo_s3_key);
    await client.query("DELETE FROM public.inspection_daily_report_photos WHERE id=$1", [photo.id]);
    await client.query("UPDATE public.inspection_daily_reports SET generated_pdf_s3_key=NULL,generated_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1", [report.id]);
    await writeAdminAudit(client, { actorUserId, action: "daily_report.updated", targetType: "inspection_daily_report", targetId: report.id, summary: `Removed photograph from Day ${report.day_number} Daily Report` });
    await client.query("COMMIT");
    return getDailyReport(requestId, report.id);
  } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
  finally { client.release(); }
};
