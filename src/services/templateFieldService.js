import crypto from "crypto";

export const FIELD_TYPES = ["text", "textarea", "number", "date", "checkbox", "yes_no", "select", "signature", "photo", "section_heading", "system_identity"];
const clean = (value, max = 200) => String(value ?? "").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, max);
const isSignature = (field) => field.type === "signature" || /signature/i.test(field.label || "");
const isIdentity = (field) => field.type === "system_identity" || /^(inspector|surveyor|consultant)( name)?$/i.test(field.label || "");

export function normalizeFields(input, { keepKeys = true } = {}) {
  if (!Array.isArray(input) || input.length > 250) throw Object.assign(new Error("Fields must be an array with no more than 250 items."), { status: 400 });
  const seen = new Set();
  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Object.assign(new Error(`Field ${index + 1} must be an object.`), { status: 400 });
    const label = clean(raw?.label, 160);
    if (!label) throw Object.assign(new Error(`Field ${index + 1} requires a label.`), { status: 400 });
    const requestedType = raw.type ?? raw.fieldType ?? "text";
    if (!FIELD_TYPES.includes(requestedType)) throw Object.assign(new Error(`Field ${index + 1} has an unsupported type.`), { status: 400 });
    const type = /signature/i.test(label) ? "signature" : /^(inspector|surveyor|consultant)( name)?$/i.test(label) ? "system_identity" : requestedType;
    const fieldKey = keepKeys && /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(raw?.fieldKey || "")
      ? raw.fieldKey
      : `field_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    if (seen.has(fieldKey)) throw Object.assign(new Error(`Duplicate field key: ${fieldKey}`), { status: 400 });
    seen.add(fieldKey);
    const coordinates = raw.sourceCoordinates;
    if (coordinates != null && (!coordinates || typeof coordinates !== "object" || Array.isArray(coordinates) || ![coordinates.x, coordinates.y, coordinates.width, coordinates.height].every((value) => Number.isFinite(Number(value))) || Number(coordinates.width) <= 0 || Number(coordinates.height) <= 0)) throw Object.assign(new Error(`Field ${index + 1} has invalid source coordinates.`), { status: 400 });
    if (raw.options != null && !Array.isArray(raw.options)) throw Object.assign(new Error(`Field ${index + 1} options must be an array.`), { status: 400 });
    let maxPhotos = undefined;
    if (type === "photo") {
      if (raw?.maxPhotos != null) {
        const num = Number(raw.maxPhotos);
        if (!Number.isInteger(num) || num < 1 || num > 10) {
          throw Object.assign(new Error(`Field "${label}" has invalid maxPhotos. Must be between 1 and 10.`), { status: 400 });
        }
        maxPhotos = num;
      } else {
        maxPhotos = 1;
      }
    }
    return {
      fieldKey,
      label,
      type,
      fieldType: type,
      required: Boolean(raw?.required),
      section: clean(raw?.section || "General", 100),
      sortOrder: Number.isFinite(Number(raw?.sortOrder)) ? Number(raw.sortOrder) : index,
      defaultValue: type === "checkbox" ? Boolean(raw?.defaultValue) : type === "system_identity" ? "NexaPort Inspector" : clean(raw?.defaultValue, 1000),
      options: type === "select" ? [...new Set((raw?.options || []).map((value) => clean(value, 100)).filter(Boolean))].slice(0, 50) : [],
      sourceFieldName: clean(raw?.sourceFieldName, 200) || null,
      sourcePageNumber: Number.isInteger(Number(raw?.sourcePageNumber)) && Number(raw.sourcePageNumber) > 0 && Number(raw.sourcePageNumber) <= 25 ? Number(raw.sourcePageNumber) : null,
      sourceCoordinates: coordinates
        ? { x: Number(coordinates.x), y: Number(coordinates.y), width: Number(coordinates.width), height: Number(coordinates.height) }
        : null,
      captionEnabled: type === "photo" && Boolean(raw?.captionEnabled),
      maxPhotos,
    };
  }).sort((a, b) => a.sortOrder - b.sortOrder).map((field, index) => ({ ...field, sortOrder: index }));
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
