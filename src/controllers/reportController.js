import crypto from "crypto";
import sharp from "sharp";
import { pool } from "../config/db.js";
import { createPresignedGetUrl } from "../utils/s3Presign.js";
import { expertIdForUser, sendTemplateError } from "./templateController.js";
import { missingRequiredFields, validateReportValues } from "../services/templateFieldService.js";
import { generateReportPdf } from "../services/pdfGenerationService.js";
import { writePrivateObject } from "../services/privateObjectService.js";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const clean = (value, max = 255) => String(value ?? "").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, max);
const validId = (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const sendError = (res, error, fallback) => sendTemplateError(res, error, fallback, "reports");

async function reportForAccess(queryable, reportId, user, { ownerOnly = false } = {}) {
  if (!validId(reportId)) throw Object.assign(new Error("Report not found."), { status: 404 });
  const roleId = Number(user.role_id);
  const expertId = roleId === 2 ? await expertIdForUser(queryable, user.id) : null;
  const result = await queryable.query(`SELECT r.*,iw.id AS workflow_id,t.title AS template_title,t.source_type,t.template_scope,u.full_name AS consultant_name,u.email AS consultant_email,v.fields_jsonb,v.layout_jsonb,v.version_number FROM inspection_reports r JOIN inspection_templates t ON t.id=r.template_id JOIN inspection_template_versions v ON v.id=r.template_version_id LEFT JOIN inspection_workflows iw ON iw.report_id=r.id LEFT JOIN experts e ON e.id=r.expert_id LEFT JOIN users u ON u.id=e.user_id WHERE r.id=$1`, [reportId]);
  const report = result.rows[0];
  const ownConsultantReport = report && !report.workflow_id && roleId === 2 && Number(report.expert_id) === Number(expertId);
  const ownPlatformTest = report && roleId === 1 && report.expert_id === null && Number(report.created_by_user_id) === Number(user.id);
  if (!report || (ownerOnly ? !(ownConsultantReport || ownPlatformTest) : !(roleId === 1 || ownConsultantReport))) throw Object.assign(new Error("Report not found or access denied."), { status: 404 });
  return { ...report, permissions: { canEdit: ownConsultantReport || ownPlatformTest, canGenerate: ownConsultantReport || ownPlatformTest } };
}

const publicReport = ({ generated_pdf_s3_key, final_pdf_s3_key, ...row }) => ({ ...row, generated: Boolean(generated_pdf_s3_key), finalized: Boolean(final_pdf_s3_key) });

export const createReport = async (req, res) => {
  try {
    const roleId = Number(req.user.role_id);
    const expertId = roleId === 2 ? await expertIdForUser(pool, req.user.id) : null;
    const template = roleId === 1
      ? await pool.query("SELECT * FROM inspection_templates WHERE id=$1 AND template_scope='nexaport' AND status<>'archived'", [req.params.id])
      : await pool.query("SELECT * FROM inspection_templates WHERE id=$1 AND ((template_scope='private' AND expert_id=$2 AND status<>'archived') OR (template_scope='nexaport' AND status='published'))", [req.params.id, expertId]);
    if (!template.rows[0] || !template.rows[0].current_version_number) return res.status(404).json({ success: false, message: "A saved template version is required." });
    const version = await pool.query("SELECT id FROM inspection_template_versions WHERE template_id=$1 AND version_number=$2", [template.rows[0].id, template.rows[0].current_version_number]);
    const serviceRequestId = req.body?.serviceRequestId ? validId(req.body.serviceRequestId) : null;
    if (req.body?.serviceRequestId && !serviceRequestId) return res.status(400).json({ success: false, message: "Service request is invalid." });
    if (serviceRequestId && roleId === 1) return res.status(400).json({ success: false, message: "Platform test reports cannot be linked to a consultant service request." });
    if (serviceRequestId) {
      const allowed = await pool.query("SELECT sr.id FROM service_requests sr WHERE sr.id=$1 AND (sr.accepted_expert_id=$2 OR EXISTS (SELECT 1 FROM request_expert_assignments rea WHERE rea.service_request_id=sr.id AND rea.expert_id=$2))", [serviceRequestId, expertId]);
      if (!allowed.rows[0]) return res.status(403).json({ success: false, message: "You are not authorized for that service request." });
    }
    const title = clean(req.body?.title || template.rows[0].title, 180);
    const created = await pool.query("INSERT INTO inspection_reports (template_id,template_version_id,expert_id,created_by_user_id,service_request_id,title,status,values_jsonb) VALUES ($1,$2,$3,$4,$5,$6,'draft','{}'::jsonb) RETURNING *", [template.rows[0].id, version.rows[0].id, expertId, req.user.id, serviceRequestId, title]);
    return res.status(201).json({ success: true, data: publicReport(created.rows[0]) });
  } catch (error) { return sendError(res, error, "Unable to create report."); }
};

export const listReports = async (req, res) => {
  try {
    const expertId = Number(req.user.role_id) === 2 ? await expertIdForUser(pool, req.user.id) : null;
    const result = await pool.query(`SELECT r.*,t.title AS template_title,t.template_scope,u.full_name AS consultant_name,u.email AS consultant_email,v.version_number FROM inspection_reports r JOIN inspection_templates t ON t.id=r.template_id JOIN inspection_template_versions v ON v.id=r.template_version_id LEFT JOIN inspection_workflows iw ON iw.report_id=r.id LEFT JOIN experts e ON e.id=r.expert_id LEFT JOIN users u ON u.id=e.user_id${expertId ? " WHERE r.expert_id=$1 AND iw.id IS NULL" : ""} ORDER BY r.updated_at DESC`, expertId ? [expertId] : []);
    return res.json({ success: true, data: result.rows.map(publicReport) });
  } catch (error) { return sendError(res, error, "Unable to load reports."); }
};

export const getReport = async (req, res) => {
  try {
    const report = await reportForAccess(pool, req.params.id, req.user);
    return res.json({ success: true, data: publicReport(report) });
  } catch (error) { return sendError(res, error, "Unable to load report."); }
};

export const updateReport = async (req, res) => {
  try {
    const report = await reportForAccess(pool, req.params.id, req.user, { ownerOnly: true });
    if (report.status === "completed") return res.status(409).json({ success: false, message: "Completed reports are immutable." });
    const values = validateReportValues(report.fields_jsonb, req.body?.values || {});
    const updated = await pool.query("UPDATE inspection_reports SET values_jsonb=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING *", [JSON.stringify(values), report.id]);
    return res.json({ success: true, data: publicReport(updated.rows[0]) });
  } catch (error) { return sendError(res, error, "Unable to save report."); }
};

export async function normalizeLocalMedia(rawBody, fields) {
  let body;
  try { body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : "{}"); }
  catch { throw Object.assign(new Error("The local media payload is invalid."), { status: 400 }); }
  if (!Array.isArray(body.media) || body.media.length > 50) throw Object.assign(new Error("The local media payload is invalid."), { status: 400 });
  const counts = new Map();
  return Promise.all(body.media.map(async (item) => {
    const field = fields.find((candidate) => candidate.fieldKey === item?.fieldKey && (candidate.type === "photo" || candidate.type === "signature" || /signature/i.test(candidate.label || "")));
    const mimeType = String(item?.mimeType || "").toLowerCase();
    const match = String(item?.dataUrl || "").match(/^data:(image\/(?:jpeg|png|webp));base64,([a-z0-9+/=]+)$/i);
    if (!field || !IMAGE_TYPES.has(mimeType) || match?.[1].toLowerCase() !== mimeType) throw Object.assign(new Error("A report image is invalid."), { status: 400 });
    const fieldKind = /signature/i.test(field.label || "") ? "signature" : field.type;
    const maxPhotos = fieldKind === "photo" ? (Number(field.maxPhotos) || 1) : 1;
    const currentCount = (counts.get(field.fieldKey) || 0) + 1;
    if (currentCount > maxPhotos) {
      throw Object.assign(new Error(`Maximum ${maxPhotos} photo${maxPhotos === 1 ? "" : "s"} allowed for ${field.label}.`), { status: 400 });
    }
    counts.set(field.fieldKey, currentCount);
    let bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw Object.assign(new Error("Report images must be 5 MB or smaller."), { status: 400 });
    let metadata;
    try { metadata = await sharp(bytes).metadata(); } catch { throw Object.assign(new Error("A report image could not be read."), { status: 400 }); }
    if (!["jpeg", "png", "webp"].includes(metadata.format)) throw Object.assign(new Error("A report image is invalid."), { status: 400 });
    let outputType = mimeType;
    if (mimeType === "image/webp") { bytes = await sharp(bytes).jpeg({ quality: 88 }).toBuffer(); outputType = "image/jpeg"; }
    return { fieldKey: field.fieldKey, type: fieldKind, label: field.label, caption: field.captionEnabled ? clean(item.caption, 500) : "", mimeType: outputType, bytes };
  }));
}

export const generateReport = async (req, res) => {
  try {
    const report = await reportForAccess(pool, req.params.id, req.user, { ownerOnly: true });
    const media = await normalizeLocalMedia(req.body, report.fields_jsonb);
    const missing = missingRequiredFields(report.fields_jsonb, report.values_jsonb, new Set(media.map((item) => item.fieldKey)));
    if (missing.length) return res.status(400).json({ success: false, message: `Complete required fields: ${missing.join(", ")}` });
    const serviceRequest = report.service_request_id ? (await pool.query("SELECT id,title,vessel_name,imo_number,port_name FROM service_requests WHERE id=$1", [report.service_request_id])).rows[0] : null;
    const bytes = await generateReportPdf({ title: report.title, fields: report.fields_jsonb, values: report.values_jsonb, photos: media, serviceRequest, status: "completed", versionNumber: report.version_number });
    const ownerPath = report.expert_id ? `experts/${report.expert_id}` : `platform/tests/${report.created_by_user_id}`;
    const key = `inspection-reports/${ownerPath}/reports/${report.id}/generated/report-v${report.version_number}-${crypto.randomUUID()}.pdf`;
    await writePrivateObject(key, "application/pdf", bytes);
    const updated = await pool.query("UPDATE inspection_reports SET generated_pdf_s3_key=$1,status='completed',completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING *", [key, report.id]);
    return res.json({ success: true, data: { ...publicReport(updated.rows[0]), fileName: `${report.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "inspection-report"}.pdf`, size: bytes.length } });
  } catch (error) { return sendError(res, error, "Unable to generate report PDF."); }
};

export const getReportDownloadUrl = async (req, res) => {
  try { const report = await reportForAccess(pool, req.params.id, req.user); if (!report.generated_pdf_s3_key) return res.status(409).json({ success: false, message: "Generate the report before downloading it." }); return res.json({ success: true, data: createPresignedGetUrl({ key: report.generated_pdf_s3_key, expiresInSeconds: 300 }) }); }
  catch (error) { return sendError(res, error, "Unable to create report download URL."); }
};
