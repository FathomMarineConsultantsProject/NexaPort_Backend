import crypto from "crypto";
import path from "path";
import { pool } from "../config/db.js";
import { createPresignedGetUrl, createPresignedPutUrl } from "../utils/s3Presign.js";
import { readPrivateObject } from "../services/privateObjectService.js";
import { extractPdfFields } from "../services/pdfExtractionService.js";
import { extractXmlFields } from "../services/xmlExtractionService.js";
import { normalizeFields } from "../services/templateFieldService.js";

const FILES = {
  pdf: { mimes: ["application/pdf"], extensions: [".pdf"], max: 10 * 1024 * 1024 },
  xml: { mimes: ["application/xml", "text/xml"], extensions: [".xml"], max: 2 * 1024 * 1024 },
};
const clean = (value, max = 255) => String(value ?? "").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, max);
const id = (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const sendError = (res, error, fallback) => res.status(error.status || 500).json({ success: false, message: error.status ? error.message : fallback });

export function validateTemplateFile({ fileName, contentType, size }) {
  const extension = path.extname(clean(fileName)).toLowerCase();
  const sourceType = extension === ".pdf" ? "pdf" : extension === ".xml" ? "xml" : null;
  const spec = FILES[sourceType];
  if (!spec || !spec.extensions.includes(extension) || !spec.mimes.includes(String(contentType).toLowerCase())) return { error: "Upload a PDF (.pdf) or XML (.xml) file with a matching MIME type." };
  if (!Number.isInteger(Number(size)) || Number(size) <= 0 || Number(size) > spec.max) return { error: `${sourceType.toUpperCase()} files must be ${sourceType === "pdf" ? "10" : "2"} MB or smaller.` };
  return { sourceType, extension, max: spec.max };
}

export async function expertIdForUser(queryable, userId) {
  const result = await queryable.query("SELECT id FROM experts WHERE user_id=$1 LIMIT 1", [userId]);
  if (!result.rows[0]) throw Object.assign(new Error("A consultant profile is required."), { status: 403 });
  return result.rows[0].id;
}

async function templateForAccess(queryable, templateId, user, { ownerOnly = false } = {}) {
  if (!id(templateId)) throw Object.assign(new Error("Template not found."), { status: 404 });
  const expertId = Number(user.role_id) === 2 ? await expertIdForUser(queryable, user.id) : null;
  if (ownerOnly && Number(user.role_id) !== 2) throw Object.assign(new Error("Super Admin access is view-only."), { status: 403 });
  const result = await queryable.query(`SELECT t.*,u.full_name AS consultant_name,u.email AS consultant_email FROM inspection_templates t JOIN experts e ON e.id=t.expert_id JOIN users u ON u.id=e.user_id WHERE t.id=$1${expertId ? " AND t.expert_id=$2" : ""}`, expertId ? [templateId, expertId] : [templateId]);
  if (!result.rows[0]) throw Object.assign(new Error("Template not found or access denied."), { status: 404 });
  return result.rows[0];
}

const publicTemplate = ({ source_s3_key, ...row }) => ({ ...row, has_source_file: Boolean(source_s3_key) });

export const listTemplates = async (req, res) => {
  try {
    const expertId = Number(req.user.role_id) === 2 ? await expertIdForUser(pool, req.user.id) : null;
    const result = await pool.query(`SELECT t.*,u.full_name AS consultant_name,u.email AS consultant_email FROM inspection_templates t JOIN experts e ON e.id=t.expert_id JOIN users u ON u.id=e.user_id${expertId ? " WHERE t.expert_id=$1" : ""} ORDER BY t.updated_at DESC`, expertId ? [expertId] : []);
    return res.json({ success: true, data: result.rows.map(publicTemplate) });
  } catch (error) { return sendError(res, error, "Unable to load templates."); }
};

export const createTemplateUploadUrl = async (req, res) => {
  try {
    const expertId = await expertIdForUser(pool, req.user.id);
    const validation = validateTemplateFile(req.body || {});
    if (validation.error) return res.status(400).json({ success: false, message: validation.error });
    const fileName = clean(req.body.fileName, 180);
    const key = `inspection-templates/experts/${expertId}/sources/${crypto.randomUUID()}${validation.extension}`;
    return res.json({ success: true, data: { uploadUrl: createPresignedPutUrl({ key, contentType: req.body.contentType, expiresIn: 300 }), key, sourceType: validation.sourceType, expiresIn: 300, fileName } });
  } catch (error) { return sendError(res, error, "Private template upload is not configured."); }
};

export const createTemplate = async (req, res) => {
  try {
    const expertId = await expertIdForUser(pool, req.user.id);
    const { title, description, key, fileName, contentType, size, sourceType } = req.body || {};
    const validation = validateTemplateFile({ fileName, contentType, size });
    if (validation.error || validation.sourceType !== sourceType || !String(key).startsWith(`inspection-templates/experts/${expertId}/sources/`)) return res.status(400).json({ success: false, message: validation.error || "Template object key is invalid." });
    if (!clean(title, 180)) return res.status(400).json({ success: false, message: "Template title is required." });
    const uploaded = await readPrivateObject(key, validation.max);
    if (uploaded.length !== Number(size) || (sourceType === "pdf" ? !uploaded.subarray(0, 5).equals(Buffer.from("%PDF-")) : !uploaded.toString("utf8", 0, 500).replace(/^\uFEFF?\s*/, "").startsWith("<"))) return res.status(400).json({ success: false, message: "Uploaded source does not match the confirmed file metadata." });
    const result = await pool.query(`INSERT INTO inspection_templates (expert_id,title,description,source_type,source_s3_key,source_file_name,source_mime_type,source_file_size,status,extraction_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft','pending') RETURNING *`, [expertId, clean(title, 180), clean(description, 2000) || null, sourceType, key, clean(fileName, 180), contentType, Number(size)]);
    return res.status(201).json({ success: true, data: publicTemplate(result.rows[0]) });
  } catch (error) { return sendError(res, error, "Unable to create template."); }
};

export const getTemplate = async (req, res) => {
  try {
    const template = await templateForAccess(pool, req.params.id, req.user);
    const versions = await pool.query("SELECT id,template_id,version_number,fields_jsonb,layout_jsonb,created_by_user_id,created_at FROM inspection_template_versions WHERE template_id=$1 ORDER BY version_number DESC", [template.id]);
    return res.json({ success: true, data: { ...publicTemplate(template), versions: versions.rows } });
  } catch (error) { return sendError(res, error, "Unable to load template."); }
};

export const getTemplateSourceUrl = async (req, res) => {
  try { const template = await templateForAccess(pool, req.params.id, req.user); return res.json({ success: true, data: createPresignedGetUrl({ key: template.source_s3_key, expiresInSeconds: 300 }) }); }
  catch (error) { return sendError(res, error, "Unable to create source download URL."); }
};

export const updateTemplate = async (req, res) => {
  try {
    const template = await templateForAccess(pool, req.params.id, req.user, { ownerOnly: true });
    const title = req.body.title === undefined ? template.title : clean(req.body.title, 180);
    if (!title) return res.status(400).json({ success: false, message: "Template title is required." });
    const status = req.body.status === "archived" ? "archived" : template.status;
    const result = await pool.query("UPDATE inspection_templates SET title=$1,description=$2,status=$3,archived_at=CASE WHEN $3='archived' THEN CURRENT_TIMESTAMP ELSE archived_at END,updated_at=CURRENT_TIMESTAMP WHERE id=$4 RETURNING *", [title, req.body.description === undefined ? template.description : clean(req.body.description, 2000) || null, status, template.id]);
    return res.json({ success: true, data: publicTemplate(result.rows[0]) });
  } catch (error) { return sendError(res, error, "Unable to update template."); }
};

export const extractTemplate = async (req, res) => {
  const client = await pool.connect();
  let template;
  try {
    template = await templateForAccess(client, req.params.id, req.user, { ownerOnly: true });
    await client.query("UPDATE inspection_templates SET extraction_status='processing',extraction_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1", [template.id]);
    const bytes = await readPrivateObject(template.source_s3_key, template.source_type === "pdf" ? FILES.pdf.max : FILES.xml.max);
    const extraction = template.source_type === "pdf" ? await extractPdfFields(bytes) : extractXmlFields(bytes);
    await client.query("BEGIN");
    const locked = await client.query("SELECT current_version_number FROM inspection_templates WHERE id=$1 FOR UPDATE", [template.id]);
    const version = Number(locked.rows[0].current_version_number) + 1;
    const created = await client.query("INSERT INTO inspection_template_versions (template_id,version_number,fields_jsonb,layout_jsonb,created_by_user_id) VALUES ($1,$2,$3,$4,$5) RETURNING *", [template.id, version, JSON.stringify(extraction.fields), JSON.stringify({ extractionMode: extraction.mode, pageCount: extraction.pageCount || null, message: extraction.message || null }), req.user.id]);
    await client.query("UPDATE inspection_templates SET extraction_status='complete',current_version_number=$1,has_photo_fields=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$3", [version, extraction.fields.some((field) => field.type === "photo"), template.id]);
    await client.query("COMMIT");
    return res.json({ success: true, data: { ...extraction, version: created.rows[0] } });
  } catch (error) {
    try { await client.query("ROLLBACK"); if (template) await client.query("UPDATE inspection_templates SET extraction_status='failed',extraction_error=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2", [clean(error.message, 500), template.id]); } catch { /* preserve original error */ }
    const safe = error.status ? error : Object.assign(new Error(template?.source_type === "pdf" ? "The PDF is password-protected or malformed." : "The XML file could not be processed."), { status: 400 });
    return sendError(res, safe, "Unable to extract fields.");
  } finally { client.release(); }
};

export const createTemplateVersion = async (req, res) => {
  const client = await pool.connect();
  try {
    const template = await templateForAccess(client, req.params.id, req.user, { ownerOnly: true });
    const fields = normalizeFields(req.body.fields);
    await client.query("BEGIN");
    const locked = await client.query("SELECT current_version_number FROM inspection_templates WHERE id=$1 FOR UPDATE", [template.id]);
    const version = Number(locked.rows[0].current_version_number) + 1;
    const created = await client.query("INSERT INTO inspection_template_versions (template_id,version_number,fields_jsonb,layout_jsonb,created_by_user_id) VALUES ($1,$2,$3,$4,$5) RETURNING *", [template.id, version, JSON.stringify(fields), JSON.stringify(req.body.layout || {}), req.user.id]);
    await client.query("UPDATE inspection_templates SET current_version_number=$1,has_photo_fields=$2,status='published',updated_at=CURRENT_TIMESTAMP WHERE id=$3", [version, fields.some((field) => field.type === "photo"), template.id]);
    await client.query("COMMIT"); return res.status(201).json({ success: true, data: created.rows[0] });
  } catch (error) { await client.query("ROLLBACK"); return sendError(res, error, "Unable to save template version."); }
  finally { client.release(); }
};
