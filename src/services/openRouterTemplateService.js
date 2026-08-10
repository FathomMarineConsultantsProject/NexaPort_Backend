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
      fields: { type: "array", items: { type: "object", additionalProperties: false, required: ["fieldKey", "label", "fieldType", "required", "sectionKey", "sortOrder", "options", "sourceText"], properties: { fieldKey: { type: "string" }, label: { type: "string" }, fieldType: { enum: [...FIELD_TYPES] }, required: { type: "boolean" }, sectionKey: { type: "string" }, sortOrder: { type: "integer" }, options: { type: "array", items: { type: "string" } }, sourceText: { type: "string" } } } },
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
      const normalized = { text }; if (Number.isFinite(Number(line.x))) normalized.x = Number(line.x); if (Number.isFinite(Number(line.y))) normalized.y = Number(line.y); if (Number.isFinite(Number(line.fontSize))) normalized.fontSize = Number(line.fontSize); if (typeof line.bold === "boolean") normalized.bold = line.bold; if (Number.isInteger(Number(line.order))) normalized.order = Number(line.order); if (typeof line.blockType === "string") normalized.blockType = line.blockType; if (Number.isInteger(Number(line.sheetIndex))) normalized.sheetIndex = Number(line.sheetIndex); if (Number.isInteger(Number(line.rowIndex))) normalized.rowIndex = Number(line.rowIndex); if (typeof line.isHeading === "boolean") normalized.isHeading = line.isHeading; if (typeof line.isInstruction === "boolean") normalized.isInstruction = line.isInstruction; if (Array.isArray(line.cells)) normalized.cells = line.cells; lines.push(normalized);
    }
    return { name: clean(part?.name, 120) || `${input.sourceType === "xlsx" ? "Sheet" : "Page"} ${index + 1}`, lines };
  }).filter((part) => part.lines.length);
  if (!pagesOrSheets.length) throw fail("Extracted textual evidence is required."); return { documentTitle: clean(input.documentTitle, 180), sourceType: input.sourceType, pagesOrSheets };
}

function validateMappedOutput(value, evidence) {
  if (!value || !Array.isArray(value.sections) || !value.sections.length || !Array.isArray(value.fields) || !value.fields.length || Object.keys(value).some((key) => !["sections", "fields"].includes(key))) throw fail("The configured field-mapping model returned unsupported structured output.", 502);
  const sectionKeys = new Set(); const sections = value.sections.map((section) => {
    const title = clean(section?.title, 160); if (!/^[a-z][a-z0-9_]{0,79}$/.test(section?.sectionKey || "") || !title || placeholder(title) || !Number.isInteger(section.sortOrder) || sectionKeys.has(section.sectionKey)) throw fail("The configured field-mapping model returned invalid sections.", 502); sectionKeys.add(section.sectionKey); return { sectionKey: section.sectionKey, title, sortOrder: section.sortOrder };
  });
  const evidenceText = evidence.pagesOrSheets.flatMap((part) => part.lines.map((line) => canonical(line.text))); const fieldKeys = new Set(); const labels = new Set();
  const fields = value.fields.map((field) => {
    const source = canonical(field?.sourceText); const label = clean(field?.label, 160).replace(/\s*\*+\s*/g, " ").replace(/\s+/g, " ").trim(); const labelKey = `${field?.sectionKey}|${canonical(label)}`;
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(field?.fieldKey || "") || fieldKeys.has(field.fieldKey) || !label || !/[\p{L}\p{N}]/u.test(label) || placeholder(label) || JUNK.test(label) || labels.has(labelKey) || !FIELD_TYPES.has(field.fieldType) || !sectionKeys.has(field.sectionKey) || !Number.isInteger(field.sortOrder) || !Array.isArray(field.options) || typeof field.required !== "boolean" || !source || !evidenceText.some((line) => line.includes(source) || source.includes(line))) throw fail("The configured field-mapping model returned invalid or unsupported fields.", 502);
    fieldKeys.add(field.fieldKey); labels.add(labelKey); const required = field.required || /\*/.test(field.sourceText); return { fieldKey: field.fieldKey, label, fieldType: field.fieldType, required, sectionKey: field.sectionKey, sortOrder: field.sortOrder, options: field.options.map((option) => clean(option, 100)).filter(Boolean), sourceText: clean(field.sourceText, 1000) };
  });
  return { sections, fields };
}

export async function mapFieldsWithOpenRouter(input, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const evidence = normalizeMappingEvidence(input); if (!env.OPENROUTER_API_KEY) throw fail("Field mapping is not configured: the API key is missing.", 503); if (!env.OPENROUTER_TEMPLATE_MODEL) throw fail("Field mapping is not configured: the model is missing.", 503); let response;
  try {
    response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000), body: JSON.stringify({ model: env.OPENROUTER_TEMPLATE_MODEL, temperature: 0, max_tokens: 1600, provider: { require_parameters: true, zdr: true }, response_format: { type: "json_schema", json_schema: outputSchema }, messages: [{ role: "system", content: "Map the complete inspection template from the supplied cleaned evidence. Preserve document order and real section headings. Asterisk means required but must not remain in labels. Group Yes/No into one yes_no field and Good/Fair/Poor or Acceptable/Unacceptable into one select field. Signatures are signature; dates are date; comments/findings/observations are textarea. Ignore placeholders, isolated options, page numbers, URLs, marketing, ratings, advertisements, QR text and disclaimers. Never invent unsupported fields. Return no reasoning. Do not create fields from spreadsheet cell coordinate labels like 'Merged heading H65:J65'. Do not turn abbreviation or reference table entries into editable fields. Do not turn instructional or explanatory paragraphs into editable fields. Do not concatenate separate metadata-row cells into one combined label. Do not expose Excel date serial numbers as labels or values. Preserve workbook sheet order, row order, and DOCX document block order. Use meaningful document headings as section titles instead of generic fallbacks. Separate label/value pairs that occur in the same row into individual fields. Remarks, Comments, Observations fields should be textarea type. Status fields with known options should be select type. Identifier fields (ID Number, Version, etc.) should remain text." }, { role: "user", content: JSON.stringify(evidence) }] }) });
  } catch (error) { throw fail(error?.name === "TimeoutError" ? "Field mapping timed out." : "The field-mapping provider is unavailable.", 503); }
  if (!response.ok) { const messages = { 400: "The configured model rejected the field-mapping request.", 401: "Field mapping authentication failed.", 402: "Field mapping credits are insufficient.", 403: "Field mapping access was denied.", 429: "Field mapping is rate limited. Please retry later." }; throw fail(messages[response.status] || "The field-mapping provider is unavailable.", [400, 401, 402, 403, 429].includes(response.status) ? response.status : 503); }
  try { const content = (await response.json())?.choices?.[0]?.message?.content; return validateMappedOutput(typeof content === "string" ? JSON.parse(content) : content, evidence); }
  catch (error) { if (error.status) throw error; throw fail("The configured field-mapping model returned malformed JSON.", 502); }
}

export { outputSchema as templateMappingOutputSchema };
