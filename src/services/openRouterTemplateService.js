const SOURCE_TYPES = new Set(["pdf", "xml", "docx", "xlsx"]);
const FIELD_TYPES = new Set(["text", "textarea", "number", "date", "checkbox", "yes_no", "select", "signature", "photo", "section_heading"]);
const FORBIDDEN_KEYS = /(?:bytes|base64|file|blob|buffer|raw|sourceData)/i;
const MAX_INPUT_CHARS = 30000;

const outputSchema = {
  name: "template_field_mapping", strict: true,
  schema: {
    type: "object", additionalProperties: false, required: ["sections", "fields", "warnings"],
    properties: {
      sections: { type: "array", items: { type: "object", additionalProperties: false, required: ["sectionKey", "title", "sortOrder"], properties: { sectionKey: { type: "string" }, title: { type: "string" }, sortOrder: { type: "integer" } } } },
      fields: { type: "array", items: { type: "object", additionalProperties: false, required: ["fieldKey", "label", "fieldType", "required", "sectionKey", "sortOrder", "options", "confidence", "sourceText"], properties: { fieldKey: { type: "string" }, label: { type: "string" }, fieldType: { enum: [...FIELD_TYPES] }, required: { type: "boolean" }, sectionKey: { type: "string" }, sortOrder: { type: "integer" }, options: { type: "array", items: { type: "string" } }, confidence: { type: "number", minimum: 0, maximum: 1 }, sourceText: { type: "string" } } } },
      warnings: { type: "array", items: { type: "string" } },
    },
  },
};

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = (value, max = 500) => String(value ?? "").replace(/[<>\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const canonical = (value) => clean(value, 1000).toLowerCase();

export function normalizeMappingEvidence(input = {}) {
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) { if (FORBIDDEN_KEYS.test(key)) throw fail("Source document bytes and files are not accepted."); visit(nested); }
  };
  visit(input);
  if (!SOURCE_TYPES.has(input.sourceType)) throw fail("Source type must be PDF, XML, DOCX or XLSX.");
  if (!Array.isArray(input.pagesOrSheets) || !input.pagesOrSheets.length) throw fail("Extracted textual evidence is required.");
  const limit = input.sourceType === "xlsx" ? 10 : 25;
  if (input.pagesOrSheets.length > limit) throw fail(`Extracted evidence exceeds the ${limit}-${input.sourceType === "xlsx" ? "worksheet" : "page"} limit.`);
  const seen = new Set(); let total = 0;
  const pagesOrSheets = input.pagesOrSheets.map((part, index) => {
    if (!Array.isArray(part?.lines)) throw fail("Each page or sheet must contain text lines.");
    const lines = [];
    for (const line of part.lines) {
      const text = clean(line?.text, 1000); const key = canonical(text);
      if (!text || seen.has(key)) continue;
      seen.add(key); total += text.length;
      if (total > MAX_INPUT_CHARS) throw fail("Extracted text is too large. Reduce the document before mapping fields.", 413);
      const normalized = { text };
      if (Number.isFinite(Number(line.x))) normalized.x = Number(line.x);
      if (Number.isFinite(Number(line.y))) normalized.y = Number(line.y);
      lines.push(normalized);
    }
    return { name: clean(part?.name, 120) || `${input.sourceType === "xlsx" ? "Sheet" : "Page"} ${index + 1}`, lines };
  }).filter((part) => part.lines.length);
  if (!pagesOrSheets.length) throw fail("Extracted textual evidence is required.");
  return { documentTitle: clean(input.documentTitle, 180), sourceType: input.sourceType, pagesOrSheets };
}

function validateMappedOutput(value, evidence) {
  if (!value || !Array.isArray(value.sections) || !value.sections.length || !Array.isArray(value.fields) || !Array.isArray(value.warnings)) throw fail("OpenRouter returned invalid structured output.", 502);
  const sectionKeys = new Set();
  for (const section of value.sections) {
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(section.sectionKey || "") || !clean(section.title, 160) || !Number.isInteger(section.sortOrder) || sectionKeys.has(section.sectionKey)) throw fail("OpenRouter returned invalid sections.", 502);
    sectionKeys.add(section.sectionKey);
  }
  const evidenceText = new Set(evidence.pagesOrSheets.flatMap((part) => part.lines.map((line) => canonical(line.text))));
  const fieldKeys = new Set();
  for (const field of value.fields) {
    const source = canonical(field.sourceText);
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(field.fieldKey || "") || fieldKeys.has(field.fieldKey) || !clean(field.label, 160) || !FIELD_TYPES.has(field.fieldType) || !sectionKeys.has(field.sectionKey) || !Number.isInteger(field.sortOrder) || !Array.isArray(field.options) || typeof field.required !== "boolean" || typeof field.confidence !== "number" || field.confidence < 0 || field.confidence > 1 || !source || ![...evidenceText].some((line) => line.includes(source) || source.includes(line))) throw fail("OpenRouter returned unsupported or invalid fields.", 502);
    fieldKeys.add(field.fieldKey);
  }
  return value;
}

export async function mapFieldsWithOpenRouter(input, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const evidence = normalizeMappingEvidence(input);
  const model = env.OPENROUTER_TEMPLATE_MODEL || (env.NODE_ENV === "production" ? null : "openrouter/free");
  if (!env.OPENROUTER_API_KEY) throw fail("OpenRouter API key is not configured.", 503);
  if (!model) throw fail("OPENROUTER_TEMPLATE_MODEL is required in production.", 503);
  let response;
  try {
    response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000), body: JSON.stringify({ model, temperature: 0, max_tokens: 2500, provider: { require_parameters: true, zdr: true }, response_format: { type: "json_schema", json_schema: outputSchema }, messages: [{ role: "system", content: "Map only inspection fields supported by the evidence. Preserve complete questions and headings. Asterisk means required; Yes/No is one yes_no field; signatures are signature; dates are date; comments/findings/observations are textarea. Ignore underscores, isolated Yes/No, marketing text and URLs. Never invent fields." }, { role: "user", content: JSON.stringify(evidence) }] }) });
  } catch (error) { throw fail(error?.name === "TimeoutError" ? "OpenRouter request timed out." : "OpenRouter is unavailable.", 503); }
  if (!response.ok) {
    const messages = { 400: "OpenRouter rejected the mapping request.", 401: "OpenRouter authentication failed.", 402: "OpenRouter credits are insufficient.", 403: "OpenRouter access was denied.", 429: "OpenRouter rate limit reached." };
    throw fail(messages[response.status] || "OpenRouter is unavailable.", [400, 401, 402, 403, 429].includes(response.status) ? response.status : 503);
  }
  let content;
  try { content = (await response.json())?.choices?.[0]?.message?.content; return validateMappedOutput(typeof content === "string" ? JSON.parse(content) : content, evidence); }
  catch (error) { if (error.status) throw error; throw fail("OpenRouter returned invalid structured output.", 502); }
}

export { outputSchema as templateMappingOutputSchema };
