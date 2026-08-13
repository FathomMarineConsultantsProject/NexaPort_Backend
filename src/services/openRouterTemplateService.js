import { isProvenanceOnlyLabel } from "../utils/templateProvenance.js";

const SOURCE_TYPES = new Set(["pdf", "xml", "docx", "xlsx"]);
const FIELD_TYPES = new Set(["text", "textarea", "number", "date", "checkbox", "yes_no", "select", "signature", "photo", "section_heading", "system_identity"]);
const CLASSIFICATIONS = new Set(["field", "section", "instruction", "reference", "decorative", "unmapped", "failed"]);
const FORBIDDEN_KEYS = /^(?:bytes|base64|file|blob|buffer|sourceData|rawPdf|rawXml)$/i;
const MAX_BLOCKS = 160;
const MAX_TEXT_CHARS = 60000;

export const templateAiFailure = (message, status = 400, retryable = false, reason = "application_error") => Object.assign(new Error(message), { status, retryable, reason });
const fail = templateAiFailure;
const clean = (value, max = 2000) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
const canonical = (value) => clean(value, 20000).normalize("NFKC").replace(/[‐‑‒–—―]/g, "-").replace(/\s+/g, " ").toLowerCase();
const clampEnv = (value, fallback, min, max) => { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback; };

const evidenceRefSchema = { type: "array", items: { type: "string" } };
const sectionSchema = { type: "object", additionalProperties: false, required: ["sectionKey", "title", "order"], properties: { sectionKey: { type: "string" }, title: { type: "string" }, order: { type: "integer" }, evidenceRefs: evidenceRefSchema } };
const fieldSchema = { type: "object", additionalProperties: false, required: ["fieldKey", "label", "fieldType", "sectionKey", "required", "options", "order", "evidenceRefs"], properties: { fieldKey: { type: "string" }, label: { type: "string" }, fieldType: { enum: [...FIELD_TYPES] }, required: { type: "boolean" }, sectionKey: { type: "string" }, order: { type: "integer" }, options: { type: "array", items: { type: "string" } }, maxPhotos: { type: "integer", minimum: 1, maximum: 10 }, sourceText: { type: "string" }, evidenceRefs: evidenceRefSchema, confidence: { type: "number", minimum: 0, maximum: 1 }, warning: { type: "string" } } };
const classificationSchema = { type: "object", additionalProperties: false, required: ["blockId", "classification", "reason"], properties: { blockId: { type: "string" }, classification: { enum: [...CLASSIFICATIONS].filter((item) => item !== "failed") }, reason: { type: "string" } } };
const evidenceItemSchema = { type: "object", additionalProperties: false, required: ["text", "evidenceRefs"], properties: { text: { type: "string" }, evidenceRefs: evidenceRefSchema } };

const mappingOutputSchema = {
  name: "template_document_mapping", strict: false,
  schema: { type: "object", additionalProperties: false, required: ["sections", "fields", "warnings"], properties: {
    documentTitle: { type: "string" }, sections: { type: "array", items: sectionSchema }, fields: { type: "array", items: fieldSchema }, classifications: { type: "array", items: classificationSchema }, notes: { type: "array", items: evidenceItemSchema }, referenceData: { type: "array", items: evidenceItemSchema }, warnings: { type: "array", items: { type: "string" } }, unmappedBlocks: { type: "array", items: classificationSchema },
  } },
};

const contextOutputSchema = {
  name: "template_document_context", strict: true,
  schema: { type: "object", additionalProperties: false, required: ["documentTitle", "outline", "glossary", "responseCodes", "warnings"], properties: {
    documentTitle: { type: "string" }, outline: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "sourceOrder", "evidenceRefs"], properties: { title: { type: "string" }, sourceOrder: { type: "integer" }, evidenceRefs: evidenceRefSchema } } },
    glossary: { type: "array", items: { type: "object", additionalProperties: false, required: ["term", "meaning", "evidenceRefs"], properties: { term: { type: "string" }, meaning: { type: "string" }, evidenceRefs: evidenceRefSchema } } },
    responseCodes: { type: "array", items: { type: "object", additionalProperties: false, required: ["code", "meaning", "evidenceRefs"], properties: { code: { type: "string" }, meaning: { type: "string" }, evidenceRefs: evidenceRefSchema } } }, warnings: { type: "array", items: { type: "string" } },
  } },
};

const visitForbidden = (value) => {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) { if (FORBIDDEN_KEYS.test(key)) throw fail("Source document bytes and files are not accepted."); visitForbidden(nested); }
};

const safeObject = (value, depth = 0) => {
  if (depth > 5 || value == null) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return typeof value === "string" ? clean(value, 4000) : value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => safeObject(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, nested]) => [clean(key, 100), safeObject(nested, depth + 1)]));
  return null;
};

export function normalizeAnalysisInput(input = {}) {
  visitForbidden(input);
  const mode = input.mode; if (!["context", "map", "consolidate"].includes(mode)) throw fail("Analysis mode must be context, map or consolidate.");
  if (!SOURCE_TYPES.has(input.sourceType)) throw fail("Source type must be PDF, XML, DOCX or XLSX.");
  const base = { mode, sourceType: input.sourceType, documentTitle: clean(input.documentTitle, 180) };
  if (mode === "consolidate") {
    if (!input.mapped || !Array.isArray(input.mapped.fields)) throw fail("Mapped chunk results are required for consolidation.");
    return { ...base, globalContext: safeObject(input.globalContext), mapped: safeObject(input.mapped) };
  }
  if (!input.chunk || !Array.isArray(input.chunk.blocks) || !input.chunk.blocks.length) throw fail("A source chunk with blocks is required.");
  if (input.chunk.blocks.length > MAX_BLOCKS) throw fail(`A source chunk may contain no more than ${MAX_BLOCKS} blocks.`, 413);
  const ids = new Set(); let textChars = 0;
  const blocks = input.chunk.blocks.map((block) => {
    const id = clean(block?.id, 100); const text = clean(block?.text, 20000);
    if (!/^block-\d+$/.test(id) || ids.has(id) || !text) throw fail("Every source block must have a unique stable ID and readable text.");
    ids.add(id); textChars += text.length; if (textChars > MAX_TEXT_CHARS) throw fail("Source chunk text exceeds the configured analysis limit.", 413);
    return { id, globalOrder: Number(block.globalOrder), partOrder: Number(block.partOrder), type: clean(block.type, 50), text, contextOnly: Boolean(block.contextOnly), metadata: safeObject(block.metadata), location: safeObject(block.location) };
  });
  return { ...base, chunk: { id: clean(input.chunk.id, 100), index: Number(input.chunk.index) || 0, blocks }, globalContext: mode === "map" ? safeObject(input.globalContext) : undefined };
}

// Compatibility for the retired /map-fields route. The AI-first workflow uses
// normalizeAnalysisInput and never sends this line-only shape.
export function normalizeMappingEvidence(input = {}) {
  visitForbidden(input); if (!SOURCE_TYPES.has(input.sourceType)) throw fail("Source type must be PDF, XML, DOCX or XLSX.");
  if (!Array.isArray(input.pagesOrSheets) || !input.pagesOrSheets.length) throw fail("Extracted textual evidence is required.");
  return { documentTitle: clean(input.documentTitle, 180), sourceType: input.sourceType, pagesOrSheets: input.pagesOrSheets.map((part, index) => ({ name: clean(part?.name, 120) || `Part ${index + 1}`, lines: (part?.lines || []).map((line) => ({ ...safeObject(line), text: clean(line?.text, 20000) })).filter((line) => line.text) })).filter((part) => part.lines.length) };
}

function validateEvidenceRefs(refs, validIds) {
  return Array.isArray(refs) && refs.length && refs.every((id) => validIds.has(id));
}

function validateContext(value, blocks) {
  if (!value || !Array.isArray(value.outline) || !Array.isArray(value.glossary) || !Array.isArray(value.responseCodes)) throw fail("The configured model returned unsupported context output.", 502);
  const ids = new Set(blocks.map((block) => block.id)); const grounded = (items) => items.filter((item) => validateEvidenceRefs(item.evidenceRefs, ids));
  return { documentTitle: clean(value.documentTitle, 180), outline: grounded(value.outline), glossary: grounded(value.glossary), responseCodes: grounded(value.responseCodes), warnings: (value.warnings || []).map((item) => clean(item, 500)).filter(Boolean) };
}

function sourceLocation(block) {
  const location = block?.location || {}; const metadata = block?.metadata || {};
  return { blockId: block?.id, globalOrder: block?.globalOrder, pageNumber: location.pageNumber ?? null, sheetIndex: location.sheetIndex ?? null, sheetName: location.sheetName ?? null, rowIndex: location.rowIndex ?? metadata.rowIndex ?? null, columnIndex: location.columnIndex ?? null, tableIndex: location.tableIndex ?? metadata.tableIndex ?? null, elementPath: location.elementPath ?? null, bounds: location.bounds ?? null };
}

const ABBREVIATIONS = new Map([["temp", "temperature"], ["lv", "level"], ["qty", "quantity"], ["q'ty", "quantity"], ["press", "pressure"], ["sign", "signature"]]);
const semanticWords = (value) => canonical(value).replace(/[_/()[\]{}:;,.!?+*=\\-]+/g, " ").split(/\s+/).filter(Boolean).map((word) => ABBREVIATIONS.get(word) || word);
const semanticGrounded = (needle, haystack) => {
  const wanted = semanticWords(needle); const available = semanticWords(haystack);
  if (!wanted.length || !available.length) return false;
  const wantedText = wanted.join(" "); const availableText = available.join(" ");
  if (availableText.includes(wantedText) || wantedText.includes(availableText)) return true;
  const availableSet = new Set(available); return wanted.filter((word) => availableSet.has(word)).length / wanted.length >= 0.6;
};
const slug = (value, fallback = "field") => canonical(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || fallback;
const uniqueKey = (requested, sectionKey, label, used) => {
  const valid = /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(requested || "") ? requested : `${slug(sectionKey, "general")}_${slug(label)}`;
  let candidate = valid; let suffix = 2;
  if (used.has(candidate)) candidate = `${slug(sectionKey, "general")}_${slug(label)}`;
  while (used.has(candidate)) candidate = `${slug(sectionKey, "general")}_${slug(label)}_${suffix++}`;
  return candidate.slice(0, 80);
};

export function validateMapping(value, blocks, allowedEvidenceRefs = null) {
  if (!value || !Array.isArray(value.sections) || !Array.isArray(value.fields)) throw fail("The configured model returned unsupported structured output.", 502);
  const blockMap = new Map(blocks.map((block) => [block.id, block])); const validIds = allowedEvidenceRefs || new Set(blockMap.keys()); const warnings = (value.warnings || []).map((item) => clean(item, 500)).filter(Boolean);
  const sectionKeys = new Set(); const sections = [];
  for (const section of value.sections) {
    const sectionKey = clean(section?.sectionKey, 80); const title = clean(section?.title, 160); const refs = [...new Set(section?.evidenceRefs || [])].filter((id) => validIds.has(id));
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(sectionKey) || sectionKeys.has(sectionKey) || !title || isProvenanceOnlyLabel(title)) continue;
    sectionKeys.add(sectionKey); const order = refs.length ? Math.min(...refs.map((id) => blockMap.get(id)?.globalOrder ?? Number(section.order ?? section.sourceOrder) ?? Number.MAX_SAFE_INTEGER)) : Number(section.order ?? section.sourceOrder) || 0; sections.push({ sectionKey, title, sourceOrder: order, evidenceRefs: refs });
  }
  if (!sections.length) { sectionKeys.add("general"); sections.push({ sectionKey: "general", title: "General", sourceOrder: 0, evidenceRefs: [...validIds].slice(0, 1) }); }
  const fields = []; const fieldKeys = new Set();
  for (const field of value.fields) {
    const refs = [...new Set(field?.evidenceRefs || [])]; const refBlocks = refs.map((id) => blockMap.get(id)).filter(Boolean); const label = clean(field.label, 160); const sourceText = clean(field?.sourceText, 2000); const evidenceText = refBlocks.map((block) => block.text).join(" "); const groundedText = !blockMap.size || semanticGrounded(sourceText || label, evidenceText);
    if (!FIELD_TYPES.has(field.fieldType) || !label || isProvenanceOnlyLabel(label) || !validateEvidenceRefs(refs, validIds) || !groundedText) { warnings.push(`Dropped ungrounded or invalid field: ${label || clean(field?.fieldKey, 160) || "unknown"}`); continue; }
    const sectionKey = sectionKeys.has(field.sectionKey) ? field.sectionKey : sections[0].sectionKey; const earliest = refBlocks.sort((a, b) => a.globalOrder - b.globalOrder)[0];
    const fieldKey = uniqueKey(clean(field?.fieldKey, 80), sectionKey, label, fieldKeys); fieldKeys.add(fieldKey);
    fields.push({ fieldKey, label, fieldType: field.fieldType, required: Boolean(field.required), sectionKey, sourceOrder: earliest?.globalOrder ?? (Number(field.order ?? field.sourceOrder) || 0), options: (field.options || []).map((item) => clean(item, 100)).filter(Boolean).slice(0, 50), maxPhotos: field.fieldType === "photo" ? Math.max(1, Math.min(10, Number(field.maxPhotos) || 1)) : undefined, sourceText: sourceText || label, evidenceRefs: refs, confidence: Math.max(0, Math.min(1, Number(field.confidence) || 0)), warning: clean(field.warning, 300), sourceLocation: sourceLocation(earliest) });
  }
  const classifications = []; const classified = new Set();
  for (const item of value.classifications || []) if (validIds.has(item.blockId) && CLASSIFICATIONS.has(item.classification) && !classified.has(item.blockId)) { classified.add(item.blockId); classifications.push({ blockId: item.blockId, classification: item.classification, reason: clean(item.reason, 300) || "Classified by AI." }); }
  if (blockMap.size) for (const block of blocks) if (!block.contextOnly && !classified.has(block.id)) classifications.push({ blockId: block.id, classification: "unmapped", reason: "The model did not return a classification for this readable block." });
  const evidenceItems = (items) => (items || []).filter((item) => validateEvidenceRefs(item.evidenceRefs, validIds)).map((item) => ({ text: clean(item.text, 1000), evidenceRefs: [...new Set(item.evidenceRefs)] }));
  const unmappedBlocks = classifications.filter((item) => item.classification === "unmapped");
  return { documentTitle: clean(value.documentTitle, 180), sections: sections.sort((a, b) => a.sourceOrder - b.sourceOrder), fields: fields.sort((a, b) => a.sourceOrder - b.sourceOrder).map((field, sortOrder) => ({ ...field, sortOrder })), classifications, notes: evidenceItems(value.notes), referenceData: evidenceItems(value.referenceData), warnings, unmappedBlocks, diagnostics: { rawMappedFields: value.fields.length, acceptedMappedFields: fields.length } };
}

export const templateAiPrompts = {
  context: "Read every supplied block. Return a grounded document outline, glossary, abbreviations, response codes, repeated table-header meanings, document identity and cross references. Do not extract fields in this pass. Every context item must cite evidenceRefs from the supplied block IDs.",
  map: "Convert the complete supplied maritime document content into reusable NexaPort template fields. Process ALL supplied readable blocks and read ALL logical content. Identify everything an inspector must enter, record, answer, select, sign, or upload. Classify every non-context block as field, section, instruction, reference, decorative, or unmapped. Use only text, textarea, number, date, checkbox, yes_no, select, signature, and photo field types. Remarks, comments and observations are textarea; signatures are signature; Yes/No is yes_no; Yes/No/N/A is select; explicit photograph requests are photo. For photo fields use a stated count from 1 to 10, otherwise maxPhotos 1. Repeated labels in different sections are separate fields and need section-aware unique keys: never globally deduplicate them. Internal source metadata such as block IDs, cell addresses/ranges, row or column numbers, XML paths, DOCX part filenames and PDF coordinates is provenance only: never use it as a visible label, section, question or description. Never invent a field, merge separate controls, turn instructions or item/reference codes into fields, or reorder source content. Every field must cite evidenceRefs from actual supplied blocks; sourceText is optional. Return uncertain content as unmapped.",
  consolidate: "Consolidate the supplied compact chunk results. Reconcile section names and true semantic duplicates while preserving every evidence reference and source order. Do not invent fields, drop coverage, or reorder for aesthetics. Return no block classifications; chunk classifications are already authoritative.",
};

export async function requestOpenRouter(input, { fetchImpl = globalThis.fetch, env = process.env, signal } = {}) {
  if (!env.OPENROUTER_API_KEY) throw fail("Template analysis is not configured: the API key is missing.", 503);
  const model = env.OPENROUTER_TEMPLATE_MODEL || "google/gemini-3.5-flash";
  const reasoningEffort = env.OPENROUTER_TEMPLATE_REASONING_EFFORT || "medium";
  const timeoutMs = clampEnv(env.OPENROUTER_TEMPLATE_TIMEOUT_MS, 90000, 10000, 120000); const maxTokens = clampEnv(env.OPENROUTER_TEMPLATE_MAX_OUTPUT_TOKENS, 8192, 1200, 12000);
  const schema = input.mode === "context" ? contextOutputSchema : mappingOutputSchema;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timeout = AbortSignal.timeout(timeoutMs); const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" }, signal: combined, body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens, reasoning: { effort: reasoningEffort }, provider: { require_parameters: true, zdr: true }, response_format: { type: "json_schema", json_schema: schema }, messages: [{ role: "system", content: templateAiPrompts[input.mode] }, { role: "user", content: JSON.stringify(input) }] }) });
    } catch (error) { if (attempt === 0 && !signal?.aborted) continue; throw fail(error?.name === "TimeoutError" ? "Template analysis timed out." : "The template-analysis provider is unavailable.", 503, true, error?.name === "TimeoutError" ? "timeout" : "network_error"); }
    if (!response.ok) {
      const retryable = response.status >= 500; if (attempt === 0 && retryable) continue;
      const messages = { 400: "The configured model rejected the template-analysis request.", 401: "Template analysis authentication failed.", 402: "Template analysis credits are insufficient.", 403: "Template analysis access was denied.", 429: "Template analysis is rate limited. Please retry later." };
      throw fail(messages[response.status] || "The template-analysis provider is unavailable.", [400,401,402,403,429].includes(response.status) ? response.status : 503, retryable, response.status === 429 ? "rate_limited" : response.status >= 500 ? "provider_unavailable" : "provider_error");
    }
    try { const content = (await response.json())?.choices?.[0]?.message?.content; return typeof content === "string" ? JSON.parse(content) : content; }
    catch { throw fail("The configured template-analysis model returned malformed JSON.", 502); }
  }
  throw fail("The template-analysis provider is unavailable.", 503, true);
}

export async function analyseTemplateSource(input, { fetchImpl = globalThis.fetch, env = process.env, signal } = {}) {
  const normalized = normalizeAnalysisInput(input); const output = await requestOpenRouter(normalized, { fetchImpl, env, signal });
  if (normalized.mode === "context") return validateContext(output, normalized.chunk.blocks);
  if (normalized.mode === "consolidate") {
    const mappedFields = normalized.mapped.fields || []; const allowed = new Set(mappedFields.flatMap((field) => field.evidenceRefs || []));
    const compactBlocks = mappedFields.flatMap((field) => (field.evidenceRefs || []).map((id) => ({ id, globalOrder: field.sourceOrder, text: field.sourceText, location: field.sourceLocation || {} })));
    return validateMapping(output, compactBlocks, allowed);
  }
  return validateMapping(output, normalized.chunk.blocks);
}

export async function mapFieldsWithOpenRouter(input, options = {}) {
  const evidence = normalizeMappingEvidence(input); const blocks = evidence.pagesOrSheets.flatMap((part, partIndex) => part.lines.map((line, index) => ({ id: `block-${partIndex * 10000 + index}`, globalOrder: partIndex * 10000 + index, partOrder: index, type: line.blockType || "text_line", text: line.text, metadata: line, location: { partIndex } })));
  return analyseTemplateSource({ mode: "map", sourceType: evidence.sourceType, documentTitle: evidence.documentTitle, chunk: { id: "legacy-chunk", index: 0, blocks }, globalContext: {} }, options);
}

export function normalizeProviderOutput(output, normalized) {
  if (normalized.mode === "context") return validateContext(output, normalized.chunk.blocks);
  if (normalized.mode === "consolidate") {
    const mappedFields = normalized.mapped.fields || []; const allowed = new Set(mappedFields.flatMap((field) => field.evidenceRefs || []));
    const compactBlocks = mappedFields.flatMap((field) => (field.evidenceRefs || []).map((id) => ({ id, globalOrder: field.sourceOrder, text: field.sourceText, location: field.sourceLocation || {} })));
    return validateMapping(output, compactBlocks, allowed);
  }
  return validateMapping(output, normalized.chunk.blocks);
}

export { mappingOutputSchema as templateMappingOutputSchema, contextOutputSchema as templateContextOutputSchema };
