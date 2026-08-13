import { z } from "zod";
import { isProvenanceOnlyLabel } from "../utils/templateProvenance.js";

export const SUPPORTED_TEMPLATE_FIELD_TYPES = ["text", "textarea", "number", "date", "checkbox", "yes_no", "select", "signature", "photo"];
const ABBREVIATIONS = new Set(["IMO", "MARPOL", "SOLAS", "ISM", "ISPS", "MEOH", "LNG", "LPG", "VOC", "PPE"]);
const fieldSchema = z.object({
  candidateId: z.string().optional(), include: z.boolean().default(true), label: z.string(),
  fieldType: z.enum(SUPPORTED_TEMPLATE_FIELD_TYPES), section: z.string().default("General"),
  order: z.number().int().nonnegative(), required: z.boolean().default(false),
  options: z.array(z.string()).default([]), evidenceRefs: z.array(z.string()).optional(),
});

const titleWord = (word) => {
  const upper = word.toUpperCase();
  if (ABBREVIATIONS.has(upper)) return upper === "MEOH" ? "MeOH" : upper;
  if (/^\d+$/.test(word)) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
};

export function sanitizeTemplateLabel(value) {
  let label = String(value ?? "").normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\ufeff]/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/_+/g, " ")
    .replace(/^[\s:;,.|/\\{}<>*_~`'\"=-]+|[\s:;,.|/\\{}<>*_~`\"=-]+$/g, "")
    .replace(/\s+/g, " ").trim();
  if (!label) return "";
  if (/^[A-Z\d\s-]+$/.test(label) || /^[a-z\d\s-]+$/.test(label) || /[_]|[a-z][A-Z]/.test(String(value))) label = label.split(/\s+/).map(titleWord).join(" ");
  label = label.replace(/\bImo\b/g, "IMO").replace(/\bMarpol\b/g, "MARPOL").replace(/\bSolas\b/g, "SOLAS").replace(/\bIsm\b/g, "ISM").replace(/\bIsps\b/g, "ISPS");
  return label.slice(0, 160);
}

const slug = (value) => sanitizeTemplateLabel(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 55) || "field";

export function sanitizeAndValidateFields(rawFields, candidates = []) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seenSemantic = new Set(); const seenKeys = new Set(); const accepted = []; const rejected = [];
  for (const raw of rawFields || []) {
    const parsed = fieldSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.include) { rejected.push({ reason: parsed.success ? "excluded" : "schema", raw }); continue; }
    const field = parsed.data; const candidate = field.candidateId ? byId.get(field.candidateId) : null;
    const label = sanitizeTemplateLabel(field.label);
    const section = sanitizeTemplateLabel(field.section) || sanitizeTemplateLabel(candidate?.section) || "General";
    if (!label || isProvenanceOnlyLabel(label) || isProvenanceOnlyLabel(section)) { rejected.push({ reason: "provenance", raw }); continue; }
    if (field.candidateId && !candidate) { rejected.push({ reason: "unknown_candidate", raw }); continue; }
    const signature = `${section.toLowerCase()}|${label.toLowerCase()}|${field.fieldType}`;
    if (seenSemantic.has(signature)) { rejected.push({ reason: "duplicate", raw }); continue; }
    seenSemantic.add(signature);
    let fieldKey = `${slug(section)}_${slug(label)}`.slice(0, 76); let suffix = 2;
    while (seenKeys.has(fieldKey)) fieldKey = `${slug(section)}_${slug(label)}_${suffix++}`.slice(0, 80);
    seenKeys.add(fieldKey);
    const evidenceRefs = candidate ? [candidate.blockId] : (field.evidenceRefs || []).filter((ref) => /^block-\d+$/.test(ref));
    accepted.push({ fieldKey, label, fieldType: field.fieldType, type: field.fieldType, required: field.required, sectionKey: slug(section), section, sourceOrder: candidate?.order ?? field.order, sortOrder: 0, options: field.fieldType === "yes_no" ? ["Yes", "No"] : [...new Set(field.options.map((item) => sanitizeTemplateLabel(item)).filter(Boolean))].slice(0, 50), evidenceRefs, sourceText: candidate?.sourceText || label, confidence: candidate ? 0.75 : 0.5, sourceLocation: candidate ? { blockId: candidate.blockId, globalOrder: candidate.order, ...candidate.metadata?.location } : null } );
  }
  accepted.sort((a, b) => a.sourceOrder - b.sourceOrder).forEach((field, index) => { field.sortOrder = index; });
  return { fields: accepted, rejected };
}

export function runTemplateQualityGate({ fields, candidates, sections }) {
  const issues = [];
  if (!fields.length && candidates.length) issues.push("All structurally obvious candidates disappeared.");
  if (!fields.length) issues.push("No fields were produced.");
  if (fields.length > 250) issues.push("Field count exceeds the supported maximum.");
  if (fields.some((field) => !field.label || !SUPPORTED_TEMPLATE_FIELD_TYPES.includes(field.fieldType))) issues.push("Fields contain empty labels or unsupported types.");
  if (fields.some((field) => isProvenanceOnlyLabel(field.label) || isProvenanceOnlyLabel(field.section))) issues.push("Fields contain parser provenance labels.");
  if (new Set(fields.map((field) => `${field.section}|${field.label}|${field.fieldType}`.toLowerCase())).size !== fields.length) issues.push("Duplicate fields remain.");
  if (fields.some((field, index) => field.sortOrder !== index)) issues.push("Field ordering is invalid.");
  if ((sections || []).some((section) => !sanitizeTemplateLabel(section.title))) issues.push("A section title is invalid.");
  return { passed: issues.length === 0, issues };
}
