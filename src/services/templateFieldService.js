import crypto from "crypto";
import { isProvenanceOnlyLabel } from "../utils/templateProvenance.js";

export const FIELD_TYPES = ["text", "textarea", "number", "date", "checkbox", "yes_no", "select", "signature", "photo", "section_heading", "system_identity"];
const clean = (value, max = 200) => String(value ?? "").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, max);
const isSignature = (field) => field.type === "signature" || /signature/i.test(field.label || "");
const isIdentity = (field) => field.type === "system_identity" || /^(inspector|surveyor|consultant)( name)?$/i.test(field.label || "");
const fieldError = (index, fieldKey, property, message) => ({ index, fieldKey: fieldKey || null, property, message });
const invalidFields = (errors) => Object.assign(new Error(`Some template fields need attention. ${errors.map((error) => error.message).join(" ")}`), { status: 400, fieldErrors: errors });

export function sanitizeFieldSourceMetadata(raw = {}, sourceType) {
  const field = { ...raw }; const integer = (value) => Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : undefined;
  delete field.sourceCoordinates;
  if (sourceType === "pdf") { const bounds = raw.sourceBounds || raw.sourceCoordinates; if (bounds && typeof bounds === "object" && !Array.isArray(bounds) && [bounds.x, bounds.y, bounds.width, bounds.height].every((value) => Number.isFinite(Number(value))) && Number(bounds.width) >= 0 && Number(bounds.height) >= 0) field.sourceCoordinates = { x: Number(bounds.x), y: Number(bounds.y), width: Number(bounds.width), height: Number(bounds.height) }; }
  if (sourceType === "docx") { for (const [target, value] of [["sourceBlockOrder", raw.sourceBlockOrder], ["sourceTableIndex", raw.sourceTableIndex ?? raw.tableIndex], ["sourceRow", raw.sourceRow ?? raw.rowIndex], ["sourceColumn", raw.sourceColumn ?? raw.columnIndex]]) { const number = integer(value); if (number !== undefined) field[target] = number; } }
  if (sourceType === "xlsx") { if (typeof raw.sourceSheet === "string" && raw.sourceSheet.trim()) field.sourceSheet = clean(raw.sourceSheet, 120); for (const [target, value] of [["sourceRow", raw.sourceRow ?? raw.rowIndex], ["sourceColumn", raw.sourceColumn ?? raw.columnIndex]]) { const number = integer(value); if (number !== undefined) field[target] = number; } }
  if (sourceType === "xml") { if (typeof raw.sourceElementPath === "string" && raw.sourceElementPath.trim().startsWith("/")) field.sourceElementPath = clean(raw.sourceElementPath, 500); const number = integer(raw.sourceBlockOrder); if (number !== undefined) field.sourceBlockOrder = number; }
  if (Array.isArray(raw.evidenceRefs)) field.evidenceRefs = [...new Set(raw.evidenceRefs.filter((value) => /^block-\d+$/.test(value)))].slice(0, 50);
  if (raw.confidence != null && Number.isFinite(Number(raw.confidence))) field.confidence = Math.max(0, Math.min(1, Number(raw.confidence)));
  if (raw.reviewWarning || raw.warning) field.reviewWarning = clean(raw.reviewWarning || raw.warning, 300) || null;
  if (raw.sourceLocation && typeof raw.sourceLocation === "object" && !Array.isArray(raw.sourceLocation)) field.sourceLocation = {
    blockId: /^block-\d+$/.test(raw.sourceLocation.blockId || "") ? raw.sourceLocation.blockId : null,
    globalOrder: integer(raw.sourceLocation.globalOrder), pageNumber: integer(raw.sourceLocation.pageNumber), sheetIndex: integer(raw.sourceLocation.sheetIndex),
    sheetName: clean(raw.sourceLocation.sheetName, 120) || null, rowIndex: integer(raw.sourceLocation.rowIndex), columnIndex: integer(raw.sourceLocation.columnIndex),
    tableIndex: integer(raw.sourceLocation.tableIndex), elementPath: clean(raw.sourceLocation.elementPath, 500) || null,
  };
  return field;
}

export function normalizeFields(input, { keepKeys = true, sourceType } = {}) {
  if (!Array.isArray(input) || input.length > 250) throw Object.assign(new Error("Fields must be an array with no more than 250 items."), { status: 400 });
  const seen = new Map(); const errors = []; const normalized = [];
  input.forEach((inputField, index) => {
    const raw = sanitizeFieldSourceMetadata(inputField, sourceType); const suppliedKey = raw?.fieldKey;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors.push(fieldError(index, suppliedKey, "field", "Field configuration is invalid.")); return; }
    const label = clean(raw?.label, 160);
    if (!label) { errors.push(fieldError(index, suppliedKey, "label", "Field label is required.")); return; }
    if (isProvenanceOnlyLabel(label)) { errors.push(fieldError(index, suppliedKey, "label", "Field label must describe the source control, not its source location.")); return; }
    const section = clean(raw?.section || "General", 100);
    if (isProvenanceOnlyLabel(section)) { errors.push(fieldError(index, suppliedKey, "section", "Field section must describe the document section, not its source location.")); return; }
    const requestedType = raw.type ?? raw.fieldType ?? "text";
    if (!FIELD_TYPES.includes(requestedType)) { errors.push(fieldError(index, suppliedKey, "type", "Field has an unsupported type.")); return; }
    if (typeof raw.required !== "undefined" && typeof raw.required !== "boolean") { errors.push(fieldError(index, suppliedKey, "required", "Required must be true or false.")); return; }
    const type = /signature/i.test(label) ? "signature" : /^(inspector|surveyor|consultant)( name)?$/i.test(label) ? "system_identity" : requestedType;
    const fieldKey = keepKeys && /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(raw?.fieldKey || "")
      ? raw.fieldKey
      : `field_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    if (seen.has(fieldKey)) { errors.push(fieldError(index, fieldKey, "fieldKey", "Field keys must be unique."), fieldError(seen.get(fieldKey), fieldKey, "fieldKey", "Field keys must be unique.")); return; }
    seen.set(fieldKey, index);
    if (raw.options != null && !Array.isArray(raw.options)) { errors.push(fieldError(index, fieldKey, "options", "Options must be a list.")); return; }
    if (type === "select" && !(raw.options || []).map((value) => clean(value, 100)).filter(Boolean).length) { errors.push(fieldError(index, fieldKey, "options", "Select fields require at least one option.")); return; }
    let maxPhotos = undefined;
    if (type === "photo") {
      if (raw?.maxPhotos != null) {
        const num = Number(raw.maxPhotos);
        if (!Number.isInteger(num) || num < 1 || num > 10) {
          errors.push(fieldError(index, fieldKey, "maxPhotos", "Maximum photos must be between 1 and 10.")); return;
        }
        maxPhotos = num;
      } else {
        maxPhotos = 1;
      }
    }
    normalized.push({
      fieldKey,
      label,
      type,
      fieldType: type,
      required: Boolean(raw?.required),
      section,
      sortOrder: Number.isFinite(Number(raw?.sortOrder)) ? Number(raw.sortOrder) : index,
      defaultValue: type === "checkbox" ? Boolean(raw?.defaultValue) : type === "system_identity" ? "NexaPort Inspector" : clean(raw?.defaultValue, 1000),
      options: type === "select" ? [...new Set((raw?.options || []).map((value) => clean(value, 100)).filter(Boolean))].slice(0, 50) : [],
      sourceFieldName: clean(raw?.sourceFieldName, 200) || null,
      sourcePageNumber: Number.isInteger(Number(raw?.sourcePageNumber)) && Number(raw.sourcePageNumber) > 0 ? Number(raw.sourcePageNumber) : null,
      sourceCoordinates: raw.sourceCoordinates || null,
      sourceBlockOrder: raw.sourceBlockOrder ?? null, sourceTableIndex: raw.sourceTableIndex ?? null, sourceRow: raw.sourceRow ?? null, sourceColumn: raw.sourceColumn ?? null, sourceSheet: raw.sourceSheet ?? null, sourceElementPath: raw.sourceElementPath ?? null,
      evidenceRefs: raw.evidenceRefs || [], confidence: raw.confidence ?? null, reviewWarning: raw.reviewWarning ?? null, sourceLocation: raw.sourceLocation ?? null,
      captionEnabled: type === "photo" && Boolean(raw?.captionEnabled),
      maxPhotos,
    });
  });
  if (errors.length) throw invalidFields(errors);
  return normalized.sort((a, b) => a.sortOrder - b.sortOrder).map((field, index) => ({ ...field, sortOrder: index }));
}

export function validateReportValues(fields, values = {}) {
  if (!values || typeof values !== "object" || Array.isArray(values)) throw Object.assign(new Error("Report values must be an object."), { status: 400 });
  const allowed = new Map(fields.map((field) => [field.fieldKey, field]));
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw Object.assign(new Error(`Unknown report field key: ${key}`), { status: 400 });
  const normalized = {};
  for (const [key, value] of Object.entries(values)) {
    const field = allowed.get(key);
    if (["photo", "section_heading"].includes(field.type) || isSignature(field) || isIdentity(field)) continue;
    if (field.type === "checkbox") normalized[key] = Boolean(value);
    else normalized[key] = clean(value, 5000);
  }
  return normalized;
}

export function missingRequiredFields(fields, values, mediaKeys = new Set()) {
  return fields.filter((field) => field.required && (field.type === "photo" || isSignature(field) ? !mediaKeys.has(field.fieldKey) : !isIdentity(field) && field.type !== "section_heading" && (values[field.fieldKey] === undefined || values[field.fieldKey] === "" || values[field.fieldKey] === false))).map((field) => field.label);
}
