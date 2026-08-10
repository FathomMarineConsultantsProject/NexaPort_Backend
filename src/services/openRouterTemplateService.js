const SOURCE_TYPES = new Set(["pdf", "xml", "docx", "xlsx"]);
const FIELD_TYPES = new Set(["text", "textarea", "number", "date", "checkbox", "yes_no", "select", "signature", "photo", "section_heading"]);
const FORBIDDEN_KEYS = /(?:bytes|base64|file|blob|buffer|raw|sourceData)/i;
const JUNK = /popprobe|lumiform|capterra|automatic reports?|template library|register.*qr|legal disclaimer|https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|org|net)\b|★|☆/i;
const MAX_INPUT_CHARS = 30000;

const outputSchema = {
  name: "template_field_mapping", strict: true,
  schema: {
    type: "object", additionalProperties: false, required: ["sections", "fields"],
    properties: {
      sections: { type: "array", items: { type: "object", additionalProperties: false, required: ["sectionKey", "title", "sortOrder"], properties: { sectionKey: { type: "string" }, title: { type: "string" }, sortOrder: { type: "integer" } } } },
      fields: { type: "array", items: { type: "object", additionalProperties: false, required: ["fieldKey", "label", "fieldType", "required", "sectionKey", "sortOrder", "options", "sourceText"], properties: { fieldKey: { type: "string" }, label: { type: "string" }, fieldType: { enum: [...FIELD_TYPES] }, required: { type: "boolean" }, sectionKey: { type: "string" }, sortOrder: { type: "integer" }, options: { type: "array", items: { type: "string" } }, sourceText: { type: "string" }, sourceBlockOrder: { type: "integer" }, tableIndex: { type: "integer" }, rowIndex: { type: "integer" }, columnIndex: { type: "integer" }, elementPath: { type: "string" } } } },
    },
  },
};

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = (value, max = 500) => String(value ?? "").replace(/[<>\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const canonical = (value) => clean(value, 1000).toLowerCase();
const placeholder = (value) => /^(?:[-–—_.\/\\|*\s]|☐|□|☑|✓|✔)+$/.test(clean(value, 1000)) || /^(?:yes|no)$/i.test(clean(value, 20));

export function normalizeMappingEvidence(input = {}) {
  const visit = (value) => { if (!value || typeof value !== "object") return; for (const [key, nested] of Object.entries(value)) { if (FORBIDDEN_KEYS.test(key)) throw fail("Source document bytes and files are not accepted."); visit(nested); } };
  visit(input); if (!SOURCE_TYPES.has(input.sourceType)) throw fail("Source type must be PDF, XML, DOCX or XLSX."); if (!Array.isArray(input.pagesOrSheets) || !input.pagesOrSheets.length) throw fail("Extracted textual evidence is required.");
  const limit = input.sourceType === "xlsx" ? 10 : 25; if (input.pagesOrSheets.length > limit) throw fail(`Extracted evidence exceeds the ${limit}-${input.sourceType === "xlsx" ? "worksheet" : "page"} limit.`);
  const seen = new Set(); let total = 0;
  const pagesOrSheets = input.pagesOrSheets.map((part, index) => {
    if (!Array.isArray(part?.lines)) throw fail("Each page or sheet must contain text lines."); const lines = [];
    for (const line of part.lines) {
      const text = clean(line?.text, 1000); const key = canonical(text); if (!text || placeholder(text) || JUNK.test(text) || /^(?:page\s*)?\d+(?:\s+of\s+\d+)?$/i.test(text) || seen.has(key)) continue; seen.add(key); total += text.length; if (total > MAX_INPUT_CHARS) throw fail("Extracted text is too large. Reduce the document before mapping fields.", 413);
      const normalized = { text }; for (const key of ["x", "y", "fontSize", "order", "headingLevel", "tableIndex", "rowIndex", "columnIndex", "sheetIndex", "depth"]) if (Number.isFinite(Number(line[key]))) normalized[key] = Number(line[key]); for (const key of ["bold", "isHeading", "isInstruction"]) if (typeof line[key] === "boolean") normalized[key] = line[key]; for (const key of ["blockType", "sourceText", "section", "itemCode", "elementName", "localName", "elementPath", "paragraphStyle"]) if (typeof line[key] === "string") normalized[key] = clean(line[key], 1000); if (Array.isArray(line.cells)) normalized.cells = line.cells.map((cell) => clean(cell, 500)); if (line.attributes && typeof line.attributes === "object") normalized.attributes = Object.fromEntries(Object.entries(line.attributes).map(([key, value]) => [clean(key, 100), clean(value, 500)])); lines.push(normalized);
    }
    return { name: clean(part?.name, 120) || `${input.sourceType === "xlsx" ? "Sheet" : "Page"} ${index + 1}`, lines };
  }).filter((part) => part.lines.length);
  if (!pagesOrSheets.length) throw fail("Extracted textual evidence is required."); return { documentTitle: clean(input.documentTitle, 180), sourceType: input.sourceType, pagesOrSheets };
}

function validateMappedOutput(value, evidence) {
  if (!value || !Array.isArray(value.sections) || !Array.isArray(value.fields)) throw fail("The configured field-mapping model returned unsupported structured output.", 502);
  const sectionKeys = new Set(); const sections = value.sections.filter((section) => { const title = clean(section?.title, 160); if (!/^[a-z][a-z0-9_]{0,79}$/.test(section?.sectionKey || "") || !title || placeholder(title) || sectionKeys.has(section.sectionKey)) return false; sectionKeys.add(section.sectionKey); return true; }).map((section, sortOrder) => ({ sectionKey: section.sectionKey, title: clean(section.title, 160), sortOrder }));
  const blocks = evidence.pagesOrSheets.flatMap((part) => part.lines); const fieldKeys = new Set(); const labels = new Set(); const fields = [];
  for (const field of value.fields) { const source = canonical(field?.sourceText); const label = clean(field?.label, 160).replace(/\s*\*+\s*/g, " ").replace(/\s+/g, " ").trim(); const labelKey = `${field?.sectionKey}|${canonical(label)}`; const associated = blocks.filter((line) => field.sourceBlockOrder == null || Number(line.order) === field.sourceBlockOrder).filter((line) => field.tableIndex == null || Number(line.tableIndex) === field.tableIndex).filter((line) => field.rowIndex == null || Number(line.rowIndex) === field.rowIndex).filter((line) => !field.elementPath || line.elementPath === field.elementPath); const grounded = (associated.length ? associated : blocks).some((line) => { const text = canonical(line.sourceText || line.text); return text.includes(source) || source.includes(text); });
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(field?.fieldKey || "") || fieldKeys.has(field.fieldKey) || !label || !/[\p{L}\p{N}]/u.test(label) || placeholder(label) || JUNK.test(label) || labels.has(labelKey) || !FIELD_TYPES.has(field.fieldType) || !sectionKeys.has(field.sectionKey) || !Array.isArray(field.options) || typeof field.required !== "boolean" || !source || !grounded) continue;
    fieldKeys.add(field.fieldKey); labels.add(labelKey); fields.push({ fieldKey: field.fieldKey, label, fieldType: field.fieldType, required: field.required || /\*/.test(field.sourceText), sectionKey: field.sectionKey, sortOrder: fields.length, options: field.options.map((option) => clean(option, 100)).filter(Boolean), sourceText: clean(field.sourceText, 1000), sourceBlockOrder: Number.isInteger(field.sourceBlockOrder) ? field.sourceBlockOrder : undefined, tableIndex: Number.isInteger(field.tableIndex) ? field.tableIndex : undefined, rowIndex: Number.isInteger(field.rowIndex) ? field.rowIndex : undefined, columnIndex: Number.isInteger(field.columnIndex) ? field.columnIndex : undefined, elementPath: typeof field.elementPath === "string" ? clean(field.elementPath, 500) : undefined });
  }
  if (!sections.length || !fields.length) throw fail("The configured field-mapping model returned no grounded fields.", 502); return { sections, fields };
}

export async function mapFieldsWithOpenRouter(input, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const evidence = normalizeMappingEvidence(input); if (!env.OPENROUTER_API_KEY) throw fail("Field mapping is not configured: the API key is missing.", 503); if (!env.OPENROUTER_TEMPLATE_MODEL) throw fail("Field mapping is not configured: the model is missing.", 503); let response;
  try {
    response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000), body: JSON.stringify({ model: env.OPENROUTER_TEMPLATE_MODEL, temperature: 0, max_tokens: 1600, provider: { require_parameters: true, zdr: true }, response_format: { type: "json_schema", json_schema: outputSchema }, messages: [{ role: "system", content: "Map structured inspection-form evidence into reusable NexaPort fields. Preserve checklist question wording, actual source order, table row/column metadata and XML hierarchy. Treat Part B1/Part B2-style markers as structural headings, not fields. Never turn instructional paragraphs, abbreviations, references, or item codes into fields; do not merge item codes into checklist questions. Group Yes/No into one yes_no field and Yes/No/N/A into select. Signatures are signature; dates are date; comments/findings/observations/remarks are textarea; status is select only when options are supplied. Do not invent fields. Every field must cite sourceText and, where supplied, sourceBlockOrder, tableIndex/rowIndex or elementPath. Return partial valid results when blocks are unclear; do not reorder for aesthetics. Do not create spreadsheet cell coordinate labels, concatenate metadata cells, or expose Excel date serial values." }, { role: "user", content: JSON.stringify(evidence) }] }) });
  } catch (error) { throw fail(error?.name === "TimeoutError" ? "Field mapping timed out." : "The field-mapping provider is unavailable.", 503); }
  if (!response.ok) { const messages = { 400: "The configured model rejected the field-mapping request.", 401: "Field mapping authentication failed.", 402: "Field mapping credits are insufficient.", 403: "Field mapping access was denied.", 429: "Field mapping is rate limited. Please retry later." }; throw fail(messages[response.status] || "The field-mapping provider is unavailable.", [400, 401, 402, 403, 429].includes(response.status) ? response.status : 503); }
  try { const content = (await response.json())?.choices?.[0]?.message?.content; return validateMappedOutput(typeof content === "string" ? JSON.parse(content) : content, evidence); }
  catch (error) { if (error.status) throw error; throw fail("The configured field-mapping model returned malformed JSON.", 502); }
}

export { outputSchema as templateMappingOutputSchema };
