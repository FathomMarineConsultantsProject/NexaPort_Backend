import { pool } from "../config/db.js";
import { normalizeFields } from "../services/templateFieldService.js";
import { mapFieldsWithAi } from "../services/templateAiProviderService.js";
import { runTemplateExtraction } from "../services/templateExtractionService.js";
import { createPresignedPutUrl } from "../utils/s3Presign.js";
import { deletePrivateObject, readPrivateObject } from "../services/privateObjectService.js";
import crypto from "crypto";

const SOURCE_TYPES = new Set(["pdf", "xml", "docx", "xlsx", "manual"]);
const EXTRACTION_METHODS = new Set(["acroform", "text", "ocr", "nexaport_xml", "generic_xml", "manual"]);
const FORBIDDEN_SOURCE_KEYS = new Set(["source_s3_key", "sourceS3Key", "key", "file", "fileName", "contentType", "size", "bytes", "base64", "sourceData", "rawPdf", "rawXml"]);
const clean = (value, max = 255) => String(value ?? "").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, max);
const id = (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const COMMIT_HASH = "cbbbeb5efa3db24102871bd70d6ae2d8ddd0b041";
const ANALYSIS_MIME_TYPES = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xml: "application/xml" };
const ANALYSIS_MAX_BYTES = { pdf: 50 * 1024 * 1024, docx: 25 * 1024 * 1024, xlsx: 25 * 1024 * 1024, xml: 5 * 1024 * 1024 };

const isDbUnavailable = (error) =>
  error?.code === "ECONNREFUSED" ||
  error?.code === "57P01" ||
  (typeof error?.code === "string" && error.code.startsWith("08"));

const isSchemaMissing = (error) =>
  error?.code === "42P01" || error?.code === "42703";

export const sendTemplateError = (res, error, fallback, operation = "templates") => {
  const code = error?.code || null;
  const status = error?.status || null;

  if (!status) {
    console.error("Inspection Templates backend error", {
      operation,
      name: error?.name,
      code: error?.code,
      message: error?.message,
      table: error?.table,
      column: error?.column,
      constraint: error?.constraint,
      commitHash: COMMIT_HASH,
    });
  }

  if (isSchemaMissing(error)) {
    const diagCode = code === "42P01" ? "TEMPLATES_SCHEMA_MISSING_TABLE" : "TEMPLATES_SCHEMA_MISSING_COLUMN";
    return res.status(503).json({
      success: false,
      code: diagCode,
      message: "Inspection Templates database update has not been installed.",
    });
  }

  if (isDbUnavailable(error)) {
    return res.status(503).json({
      success: false,
      code: "TEMPLATES_DATABASE_UNAVAILABLE",
      message: "Inspection Templates database service is temporarily unavailable.",
    });
  }

  if (code === "23514" || code === "23502" || code === "23503") {
    return res.status(status || 400).json({
      success: false,
      code: "TEMPLATES_SCHEMA_CONSTRAINT_MISMATCH",
      message: status ? error.message : "The request violated a database integrity constraint.",
    });
  }

  if (code === "23505") {
    return res.status(status || 409).json({
      success: false,
      code: "TEMPLATES_SCHEMA_CONSTRAINT_MISMATCH",
      message: status ? error.message : "A record with matching details already exists.",
    });
  }

  return res.status(status || 500).json({
    success: false,
    ...(error?.code ? { code: error.code } : {}),
    message: status ? error.message : fallback,
    ...(Array.isArray(error?.fieldErrors) ? { fieldErrors: error.fieldErrors } : {}),
  });
};

const sendError = (res, error, fallback) => sendTemplateError(res, error, fallback);
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const templateSelect = `SELECT t.*,u.full_name AS consultant_name,u.email AS consultant_email,creator.full_name AS creator_name,creator.email AS creator_email FROM inspection_templates t LEFT JOIN experts e ON e.id=t.expert_id LEFT JOIN users u ON u.id=e.user_id LEFT JOIN users creator ON creator.id=t.created_by_user_id`;

function rejectSourceContent(body = {}) {
  const visit = (value) => {
    if (typeof value === "string" && (/^data:application\/(?:pdf|xml)/i.test(value) || value.startsWith("%PDF-"))) throw badRequest("Original template file content is not accepted.");
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_SOURCE_KEYS.has(key)) throw badRequest("Original template files and source-storage metadata are not accepted.");
      visit(nested);
    }
  };
  visit(body);
}

function normalizeLayout(input = {}, extractionMethod) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw badRequest("Template layout metadata must be an object.");
  const method = extractionMethod || input.extractionMethod || input.extractionMode || "manual";
  if (!EXTRACTION_METHODS.has(method)) throw badRequest("Extraction method is invalid.");
  const pageCount = input.pageCount == null ? null : Number(input.pageCount);
  if (pageCount !== null && (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 10000)) throw badRequest("Template page count is invalid.");
  return { extractionMethod: method, pageCount };
}

export function validateTemplatePayload(body = {}) {
  rejectSourceContent(body);
  const title = clean(body.title, 180);
  if (!title) throw badRequest("Template title is required.");
  if (!SOURCE_TYPES.has(body.sourceType)) throw badRequest("Template source type must be PDF, XML, DOCX, XLSX or manual.");
  const fields = normalizeFields(body.fields || [], { sourceType: body.sourceType });
  if (!fields.length && body.sourceType !== "manual") throw badRequest("At least one normalized field is required.");
  return { title, description: clean(body.description, 2000) || null, sourceType: body.sourceType, fields, layout: normalizeLayout(body.layout, body.extractionMethod) };
}

export async function expertIdForUser(queryable, userId) {
  const result = await queryable.query("SELECT id FROM experts WHERE user_id=$1 LIMIT 1", [userId]);
  if (!result.rows[0]) throw Object.assign(new Error("A consultant profile is required."), { status: 403 });
  return result.rows[0].id;
}

export function templatePermissions(template, roleId, expertId = null) {
  const nexaport = template.template_scope === "nexaport";
  const ownPrivate = !nexaport && Number(template.expert_id) === Number(expertId);
  return {
    canEdit: Number(roleId) === 1 ? nexaport : Number(roleId) === 2 && ownPrivate,
    canArchive: Number(roleId) === 1 ? nexaport : Number(roleId) === 2 && ownPrivate,
    canUse: Boolean(template.current_version_number) && template.status !== "archived" && (Number(roleId) === 1 ? nexaport : ownPrivate || (nexaport && template.status === "published")),
    canDuplicate: Number(roleId) === 2 && nexaport && template.status === "published",
  };
}

async function templateForAccess(queryable, templateId, user, { ownerOnly = false } = {}) {
  if (!id(templateId)) throw Object.assign(new Error("Template not found."), { status: 404 });
  const roleId = Number(user.role_id); const expertId = roleId === 2 ? await expertIdForUser(queryable, user.id) : null;
  const template = (await queryable.query(`${templateSelect} WHERE t.id=$1`, [templateId])).rows[0];
  const readable = template && (roleId === 1 || (template.template_scope === "private" && Number(template.expert_id) === Number(expertId)) || (template.template_scope === "nexaport" && template.status === "published"));
  const editable = template && (roleId === 1 ? template.template_scope === "nexaport" : roleId === 2 && template.template_scope === "private" && Number(template.expert_id) === Number(expertId));
  if (!(ownerOnly ? editable : readable)) throw Object.assign(new Error("Template not found or access denied."), { status: 404 });
  return { ...template, permissions: templatePermissions(template, roleId, expertId) };
}

const publicTemplate = ({ source_s3_key, source_file_name, source_mime_type, source_file_size, permissions, ...row }) => ({ ...row, templateScope: row.template_scope, isNexaPortProvided: row.template_scope === "nexaport", permissions });

export const listTemplates = async (req, res) => {
  try {
    const roleId = Number(req.user.role_id); const expertId = roleId === 2 ? await expertIdForUser(pool, req.user.id) : null;
    const where = roleId === 2 ? " WHERE (t.template_scope='private' AND t.expert_id=$1) OR (t.template_scope='nexaport' AND t.status='published')" : "";
    const result = await pool.query(`${templateSelect}${where} ORDER BY t.template_scope DESC,t.updated_at DESC`, expertId ? [expertId] : []);
    return res.json({ success: true, data: result.rows.map((row) => publicTemplate({ ...row, permissions: templatePermissions(row, roleId, expertId) })) });
  } catch (error) { return sendError(res, error, "Unable to load templates."); }
};

export const mapTemplateFields = async (req, res) => {
  try { return res.json({ success: true, data: await mapFieldsWithAi(req.body || {}) }); }
  catch (error) { return sendError(res, error, "Unable to map template fields."); }
};

export const createAnalyseTemplate = ({ runExtraction = runTemplateExtraction } = {}) => async (req, res) => {
  const controller = new AbortController(); req.once("aborted", () => controller.abort());
  try {
    const sourceType = String(req.body?.sourceType || "").toLowerCase();
    console.info("Template extraction stage", { stage: "upload_received", provider: null, status: 200, sourceType, fileSize: req.file?.size || 0 });
    const data = await runExtraction(req.file, { sourceType, signal: controller.signal });
    console.info("Template extraction diagnostics:", { stage: "quality_gate_complete", provider: "openrouter", status: 200, sourceType, parsedBlocks: data.diagnostics.parsedBlocks, candidates: data.diagnostics.candidateCount, finalFields: data.fields.length, degraded: data.degraded, durationMs: data.diagnostics.durationMs });
    return res.json({ success: true, data });
  }
  catch (error) {
    console.error("Template extraction failed", { stage: error?.stage || (error?.code === "DOCUMENT_PARSE_FAILED" ? "document_parse" : "ai_provider"), provider: error?.provider || null, status: error?.status || 500, category: error?.code || error?.reason || "FIELD_EXTRACTION_FAILED", message: String(error?.safeProviderMessage || error?.message || "Extraction failed").slice(0, 240) });
    return sendError(res, error, "Unable to analyse template source.");
  }
};
export const analyseTemplate = createAnalyseTemplate();

export const createTemplateAnalysisUpload = async (req, res) => {
  try {
    const sourceType = String(req.body?.sourceType || "").toLowerCase(); const contentType = String(req.body?.contentType || "").toLowerCase(); const size = Number(req.body?.size);
    if (!ANALYSIS_MIME_TYPES[sourceType] || !Number.isInteger(size) || size < 1 || size > ANALYSIS_MAX_BYTES[sourceType]) throw badRequest("Template analysis upload metadata is invalid.");
    if (contentType !== ANALYSIS_MIME_TYPES[sourceType] && !(sourceType === "xml" && contentType === "text/xml")) throw badRequest("Template analysis content type does not match the selected format.");
    const objectKey = `temporary/template-analysis/${req.user.id}/${crypto.randomUUID()}.${sourceType}`;
    const uploadUrl = createPresignedPutUrl({ key: objectKey, contentType, expiresIn: 300 });
    return res.json({ success: true, data: { objectKey, uploadUrl, expiresInSeconds: 300 } });
  } catch (error) { return sendError(res, error, "Unable to prepare the temporary template upload."); }
};

export const analyseTemplateObject = async (req, res) => {
  const controller = new AbortController(); req.once("aborted", () => controller.abort()); let objectKey = "";
  try {
    const sourceType = String(req.body?.sourceType || "").toLowerCase(); objectKey = String(req.body?.objectKey || ""); const size = Number(req.body?.size); const contentType = String(req.body?.contentType || "");
    const prefix = `temporary/template-analysis/${req.user.id}/`;
    if (!ANALYSIS_MIME_TYPES[sourceType] || !objectKey.startsWith(prefix) || !new RegExp(`^[a-z0-9/_-]+\\.${sourceType}$`, "i").test(objectKey) || !Number.isInteger(size) || size < 1 || size > ANALYSIS_MAX_BYTES[sourceType]) throw badRequest("Temporary template upload reference is invalid.");
    const buffer = await readPrivateObject(objectKey, ANALYSIS_MAX_BYTES[sourceType]);
    const file = { buffer, size: buffer.length, originalname: clean(req.body?.fileName, 180) || `document.${sourceType}`, mimetype: contentType || ANALYSIS_MIME_TYPES[sourceType] };
    const data = await runTemplateExtraction(file, { sourceType, signal: controller.signal });
    return res.json({ success: true, data });
  } catch (error) { return sendError(res, error, "Unable to analyse the temporary template source."); }
  finally { if (objectKey) try { await deletePrivateObject(objectKey); } catch (error) { console.warn("Temporary template source cleanup failed", { keySuffix: objectKey.slice(-48), message: error.message }); } }
};

export const createTemplate = async (req, res) => {
  const client = await pool.connect();
  try {
    const payload = validateTemplatePayload(req.body || {}); const roleId = Number(req.user.role_id);
    const expertId = roleId === 2 ? await expertIdForUser(client, req.user.id) : null; const scope = roleId === 1 ? "nexaport" : "private"; const status = scope === "private" ? "published" : "draft";
    const extractionMethod = payload.layout.extractionMethod || "manual";
    await client.query("BEGIN");
    const created = await client.query("INSERT INTO inspection_templates (expert_id,template_scope,created_by_user_id,title,description,source_type,extraction_method,status,extraction_status,current_version_number,has_photo_fields) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'complete',1,$9) RETURNING *", [expertId, scope, req.user.id, payload.title, payload.description, payload.sourceType, extractionMethod, status, payload.fields.some((field) => field.type === "photo")]);
    const version = await client.query("INSERT INTO inspection_template_versions (template_id,version_number,fields_jsonb,layout_jsonb,created_by_user_id) VALUES ($1,1,$2,$3,$4) RETURNING *", [created.rows[0].id, JSON.stringify(payload.fields), JSON.stringify(payload.layout), req.user.id]);
    await client.query("COMMIT");
    const row = created.rows[0]; return res.status(201).json({ success: true, data: { ...publicTemplate({ ...row, permissions: templatePermissions(row, roleId, expertId) }), versions: [version.rows[0]] } });
  } catch (error) { try { await client.query("ROLLBACK"); } catch { /* no open transaction */ } return sendError(res, error, "Unable to create template."); }
  finally { client.release(); }
};

export const getTemplate = async (req, res) => {
  try { const template = await templateForAccess(pool, req.params.id, req.user); const versions = await pool.query("SELECT id,template_id,version_number,fields_jsonb,layout_jsonb,created_by_user_id,created_at FROM inspection_template_versions WHERE template_id=$1 ORDER BY version_number DESC", [template.id]); return res.json({ success: true, data: { ...publicTemplate(template), versions: versions.rows } }); }
  catch (error) { return sendError(res, error, "Unable to load template."); }
};

export const updateTemplate = async (req, res) => {
  try {
    rejectSourceContent(req.body || {}); const template = await templateForAccess(pool, req.params.id, req.user, { ownerOnly: true }); const title = req.body.title === undefined ? template.title : clean(req.body.title, 180);
    if (!title) return res.status(400).json({ success: false, message: "Template title is required." });
    const requestedStatus = ["draft", "published", "archived"].includes(req.body.status) ? req.body.status : template.status;
    if (template.status === "published" && requestedStatus === "draft") { const completed = await pool.query("SELECT 1 FROM inspection_reports WHERE template_id=$1 AND status='completed' LIMIT 1", [template.id]); if (completed.rows.length) return res.status(409).json({ success: false, message: "A template with completed reports cannot return to draft." }); }
    const row = (await pool.query("UPDATE inspection_templates SET title=$1,description=$2,status=$3,archived_at=CASE WHEN $3='archived' THEN CURRENT_TIMESTAMP ELSE NULL END,updated_at=CURRENT_TIMESTAMP WHERE id=$4 RETURNING *", [title, req.body.description === undefined ? template.description : clean(req.body.description, 2000) || null, requestedStatus, template.id])).rows[0];
    return res.json({ success: true, data: publicTemplate({ ...row, permissions: templatePermissions(row, req.user.role_id, template.expert_id) }) });
  } catch (error) { return sendError(res, error, "Unable to update template."); }
};

export const createTemplateVersion = async (req, res) => {
  const client = await pool.connect();
  try {
    rejectSourceContent(req.body || {}); const template = await templateForAccess(client, req.params.id, req.user, { ownerOnly: true }); const fields = normalizeFields(req.body.fields, { sourceType: template.source_type });
    if (!fields.length) throw badRequest("At least one normalized field is required.");
    const layout = normalizeLayout(req.body.layout);
    await client.query("BEGIN"); const locked = await client.query("SELECT current_version_number FROM inspection_templates WHERE id=$1 FOR UPDATE", [template.id]); const version = Number(locked.rows[0].current_version_number) + 1;
    const created = await client.query("INSERT INTO inspection_template_versions (template_id,version_number,fields_jsonb,layout_jsonb,created_by_user_id) VALUES ($1,$2,$3,$4,$5) RETURNING *", [template.id, version, JSON.stringify(fields), JSON.stringify(layout), req.user.id]);
    const status = template.template_scope === "private" ? "published" : template.status; await client.query("UPDATE inspection_templates SET current_version_number=$1,has_photo_fields=$2,status=$3,extraction_status='complete',updated_at=CURRENT_TIMESTAMP WHERE id=$4", [version, fields.some((field) => field.type === "photo"), status, template.id]);
    await client.query("COMMIT"); return res.status(201).json({ success: true, data: created.rows[0] });
  } catch (error) { try { await client.query("ROLLBACK"); } catch { /* no open transaction */ } return sendError(res, error, "Unable to save template version."); }
  finally { client.release(); }
};

export const duplicateTemplate = async (req, res) => {
  const client = await pool.connect();
  try {
    const expertId = await expertIdForUser(client, req.user.id); const source = (await client.query(`${templateSelect} WHERE t.id=$1 AND t.template_scope='nexaport' AND t.status='published'`, [req.params.id])).rows[0];
    if (!source?.current_version_number) return res.status(404).json({ success: false, message: "Published NexaPort template not found." });
    const sourceVersion = (await client.query("SELECT fields_jsonb,layout_jsonb FROM inspection_template_versions WHERE template_id=$1 AND version_number=$2", [source.id, source.current_version_number])).rows[0];
    await client.query("BEGIN");
    const createdExtractionMethod = source.extraction_method || "manual";
    const copied = await client.query("INSERT INTO inspection_templates (expert_id,template_scope,created_by_user_id,title,description,source_type,extraction_method,status,extraction_status,current_version_number,has_photo_fields) VALUES ($1,'private',$2,$3,$4,$5,$6,'published','complete',1,$7) RETURNING *", [expertId, req.user.id, `${source.title} Copy`.slice(0, 180), source.description, source.source_type, createdExtractionMethod, source.has_photo_fields]);
    const version = await client.query("INSERT INTO inspection_template_versions (template_id,version_number,fields_jsonb,layout_jsonb,created_by_user_id) VALUES ($1,1,$2,$3,$4) RETURNING *", [copied.rows[0].id, JSON.stringify(sourceVersion.fields_jsonb), JSON.stringify(sourceVersion.layout_jsonb), req.user.id]);
    await client.query("COMMIT"); const row = copied.rows[0];
    return res.status(201).json({ success: true, data: { ...publicTemplate({ ...row, permissions: templatePermissions(row, 2, expertId) }), versions: [version.rows[0]] } });
  } catch (error) { try { await client.query("ROLLBACK"); } catch { /* no open transaction */ } return sendError(res, error, "Unable to duplicate template."); }
  finally { client.release(); }
};
