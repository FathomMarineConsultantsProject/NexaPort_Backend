import crypto from "crypto";
import path from "path";
import sharp from "sharp";
import { pool } from "../config/db.js";
import { createPresignedGetUrl, createPresignedPutUrl } from "../utils/s3Presign.js";
import { expertIdForUser, sendTemplateError } from "./templateController.js";
import { missingRequiredFields, validateReportValues } from "../services/templateFieldService.js";
import { generateReportPdf } from "../services/pdfGenerationService.js";
import { readPrivateObject, writePrivateObject } from "../services/privateObjectService.js";

const IMAGE_TYPES = { "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"], "image/webp": [".webp"] };
const clean = (value, max = 255) => String(value ?? "").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, max);
const validId = (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const sendError = (res, error, fallback) => sendTemplateError(res, error, fallback, "reports");

async function reportForAccess(queryable, reportId, user, { ownerOnly = false } = {}) {
  if (!validId(reportId)) throw Object.assign(new Error("Report not found."), { status: 404 });
  const roleId = Number(user.role_id);
  const expertId = roleId === 2 ? await expertIdForUser(queryable, user.id) : null;
  const result = await queryable.query(`SELECT r.*,t.title AS template_title,t.source_type,t.template_scope,u.full_name AS consultant_name,u.email AS consultant_email,v.fields_jsonb,v.layout_jsonb,v.version_number FROM inspection_reports r JOIN inspection_templates t ON t.id=r.template_id JOIN inspection_template_versions v ON v.id=r.template_version_id LEFT JOIN experts e ON e.id=r.expert_id LEFT JOIN users u ON u.id=e.user_id WHERE r.id=$1`, [reportId]);
  const report = result.rows[0];
  const ownConsultantReport = report && roleId === 2 && Number(report.expert_id) === Number(expertId);
  const ownPlatformTest = report && roleId === 1 && report.expert_id === null && Number(report.created_by_user_id) === Number(user.id);
  if (!report || (ownerOnly ? !(ownConsultantReport || ownPlatformTest) : !(roleId === 1 || ownConsultantReport))) throw Object.assign(new Error("Report not found or access denied."), { status: 404 });
  return { ...report, permissions: { canEdit: ownConsultantReport || ownPlatformTest, canGenerate: ownConsultantReport || ownPlatformTest } };
}

const publicReport = ({ generated_pdf_s3_key, ...row }) => ({ ...row, generated: Boolean(generated_pdf_s3_key) });

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
    const result = await pool.query(`SELECT r.*,t.title AS template_title,t.template_scope,u.full_name AS consultant_name,u.email AS consultant_email,v.version_number FROM inspection_reports r JOIN inspection_templates t ON t.id=r.template_id JOIN inspection_template_versions v ON v.id=r.template_version_id LEFT JOIN experts e ON e.id=r.expert_id LEFT JOIN users u ON u.id=e.user_id${expertId ? " WHERE r.expert_id=$1" : ""} ORDER BY r.updated_at DESC`, expertId ? [expertId] : []);
    return res.json({ success: true, data: result.rows.map(publicReport) });
  } catch (error) { return sendError(res, error, "Unable to load reports."); }
};

export const getReport = async (req, res) => {
  try {
    const report = await reportForAccess(pool, req.params.id, req.user);
    const photos = await pool.query("SELECT id,field_key,caption,sort_order,uploaded_at FROM inspection_report_photos WHERE report_id=$1 ORDER BY sort_order,uploaded_at", [report.id]);
    return res.json({ success: true, data: { ...publicReport(report), photos: photos.rows } });
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

function validatePhoto(body) {
  const contentType = String(body?.contentType || "").toLowerCase(); const extension = path.extname(clean(body?.fileName)).toLowerCase(); const allowed = IMAGE_TYPES[contentType];
  if (!allowed?.includes(extension)) return "Upload a JPEG, PNG, or WebP image with a matching extension.";
  if (!Number.isInteger(Number(body?.size)) || Number(body.size) <= 0 || Number(body.size) > 5 * 1024 * 1024) return "Photos must be 5 MB or smaller.";
  return null;
}

export const createPhotoUploadUrl = async (req, res) => {
  try {
    const report = await reportForAccess(pool, req.params.id, req.user, { ownerOnly: true }); const field = report.fields_jsonb.find((item) => item.fieldKey === req.body?.fieldKey && item.type === "photo");
    if (!field) return res.status(400).json({ success: false, message: "Photo uploads require a configured photo field." });
    const error = validatePhoto(req.body); if (error) return res.status(400).json({ success: false, message: error });
    const ownerPath = report.expert_id ? `experts/${report.expert_id}` : `platform/tests/${report.created_by_user_id}`;
    const extension = path.extname(clean(req.body.fileName)).toLowerCase(); const key = `inspection-reports/${ownerPath}/reports/${report.id}/photos/${field.fieldKey}/${crypto.randomUUID()}${extension}`;
    return res.json({ success: true, data: { uploadUrl: createPresignedPutUrl({ key, contentType: req.body.contentType, expiresIn: 300 }), key, expiresIn: 300 } });
  } catch (error) { return sendError(res, error, "Private photo upload is not configured."); }
};

export const registerPhoto = async (req, res) => {
  try {
    const report = await reportForAccess(pool, req.params.id, req.user, { ownerOnly: true }); const field = report.fields_jsonb.find((item) => item.fieldKey === req.body?.fieldKey && item.type === "photo");
    const ownerPath = report.expert_id ? `experts/${report.expert_id}` : `platform/tests/${report.created_by_user_id}`;
    const prefix = `inspection-reports/${ownerPath}/reports/${report.id}/photos/${field?.fieldKey}/`;
    if (!field || !String(req.body?.key).startsWith(prefix)) return res.status(400).json({ success: false, message: "Photo object key is invalid." });
    const uploaded = await readPrivateObject(req.body.key, 5 * 1024 * 1024);
    try { const metadata = await sharp(uploaded).metadata(); if (!["jpeg", "png", "webp"].includes(metadata.format)) throw new Error(); } catch { return res.status(400).json({ success: false, message: "Uploaded object is not a valid JPEG, PNG, or WebP image." }); }
    const created = await pool.query("INSERT INTO inspection_report_photos (report_id,field_key,photo_s3_key,caption,sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id,field_key,caption,sort_order,uploaded_at", [report.id, field.fieldKey, req.body.key, field.captionEnabled ? clean(req.body.caption, 500) || null : null, Number(req.body.sortOrder) || 0]);
    return res.status(201).json({ success: true, data: created.rows[0] });
  } catch (error) { return sendError(res, error, "Unable to register photo."); }
};

export const generateReport = async (req, res) => {
  try {
    const report = await reportForAccess(pool, req.params.id, req.user, { ownerOnly: true });
    const photoRows = await pool.query("SELECT p.*,COALESCE(p.caption,'') AS caption FROM inspection_report_photos p WHERE p.report_id=$1 ORDER BY p.sort_order,p.uploaded_at", [report.id]);
    const missing = missingRequiredFields(report.fields_jsonb, report.values_jsonb, new Set(photoRows.rows.map((photo) => photo.field_key)));
    if (missing.length) return res.status(400).json({ success: false, message: `Complete required fields: ${missing.join(", ")}` });
    const photos = await Promise.all(photoRows.rows.map(async (photo) => {
      const extension = path.extname(photo.photo_s3_key).toLowerCase();
      let bytes = await readPrivateObject(photo.photo_s3_key, 5 * 1024 * 1024);
      let mimeType = extension === ".png" ? "image/png" : "image/jpeg";
      if (extension === ".webp") { bytes = await sharp(bytes).jpeg({ quality: 88 }).toBuffer(); mimeType = "image/jpeg"; }
      return { label: report.fields_jsonb.find((field) => field.fieldKey === photo.field_key)?.label, caption: photo.caption, mimeType, bytes };
    }));
    const serviceRequest = report.service_request_id ? (await pool.query("SELECT id,title FROM service_requests WHERE id=$1", [report.service_request_id])).rows[0] : null;
    const bytes = await generateReportPdf({ title: report.title, fields: report.fields_jsonb, values: report.values_jsonb, photos, consultant: { full_name: report.consultant_name, email: report.consultant_email }, serviceRequest });
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
