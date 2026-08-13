import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import {
  normalizeAnalysisInput,
  normalizeMappingEvidence,
  normalizeProviderOutput,
  requestOpenRouter,
  templateAiFailure,
  templateAiPrompts,
  templateContextOutputSchema,
  templateMappingOutputSchema,
} from "./openRouterTemplateService.js";

const DEFAULTS = Object.freeze({
  geminiModel: "gemini-3.6-flash",
  geminiThinking: "medium",
  geminiTimeoutMs: 90000,
  geminiMaxOutputTokens: 8192,
  openRouterModel: "google/gemini-3.5-flash",
});

const THINKING_LEVELS = Object.freeze({ low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM });

const boundedNumber = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const statusFrom = (error) => Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.cause?.status ?? 0);
const errorCode = (error) => String(error?.code ?? error?.cause?.code ?? "").toUpperCase();
const errorMessage = (error) => String(error?.message ?? error?.cause?.message ?? "").toLowerCase();
const safeProviderMessage = (value, env = process.env) => {
  let message = String(value || "Provider execution failed").slice(0, 240).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]").replace(/(?:api[_ -]?key|token)\s*[:=]\s*[^\s,;]+/gi, "credential=[REDACTED]");
  for (const secret of [env.GEMINI_API_KEY, env.OPENROUTER_API_KEY].filter(Boolean)) message = message.split(secret).join("[REDACTED]");
  return message;
};

export function classifyGeminiFailure(error) {
  const status = statusFrom(error); const code = errorCode(error); const message = errorMessage(error);
  if (status === 429 || code === "RESOURCE_EXHAUSTED" || /resource[_ ]exhausted|quota (?:exhausted|temporarily)|rate[ -]?limit/.test(message)) return { reason: "rate_limited", fallbackAllowed: true, retry: false };
  if (status >= 500 || /service unavailable|temporar(?:y|ily) unavailable/.test(message)) return { reason: "provider_unavailable", fallbackAllowed: true, retry: true };
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH"].includes(code) || error?.name === "TimeoutError" || error?.name === "AbortError" && error?.templateTimeout || /network error|fetch failed|timed out|timeout/.test(message)) return { reason: error?.name === "TimeoutError" || /timed out|timeout/.test(message) ? "timeout" : "network_error", fallbackAllowed: true, retry: true };
  if (status === 402 || /payment required|insufficient (?:credit|fund)/.test(message)) return { reason: "payment_required", fallbackAllowed: false, retry: false };
  if (status === 401 || ["UNAUTHENTICATED", "API_KEY_INVALID"].includes(code) || /api key.*(?:invalid|not valid)|authentication|unauthenticated/.test(message)) return { reason: "authentication_error", fallbackAllowed: false, retry: false };
  if (status === 403 || /permission denied|access denied|model.*not.*available/.test(message)) return { reason: "access_denied", fallbackAllowed: false, retry: false };
  return { reason: "application_error", fallbackAllowed: false, retry: false };
}

const parseJson = (value) => {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(String(value ?? "")); }
  catch { throw templateAiFailure("The configured template-analysis model returned malformed JSON.", 502, false, "invalid_response"); }
};

const DOCUMENT_PURPOSE_PREAMBLE = `Before extracting fields, identify the document's primary purpose from these categories: fillable form, checklist, inspection checklist, hourly measurement sheet, index/reference document, procedural instruction, Yes/No checklist, record/log, or spreadsheet form. An index or reference document listing other documents may legitimately produce zero fields. Instruction sentences (e.g. "No changes should be made to revision number") must NOT become fields. Infer fields from structural and form semantics: items with Yes/No/N/A options become select fields, items labeled "(Sign)" or "Checked By" become signature fields, items labeled "Remarks" or "Other Remarks" become textarea fields, and measurement values to be recorded become number or text fields even without explicit input prompts.

`;

const buildExtractionSystemPrompt = (mode) => mode === 'map' ? DOCUMENT_PURPOSE_PREAMBLE + templateAiPrompts[mode] : templateAiPrompts[mode];

export async function analyseWithGemini(normalized, { env = process.env, signal, geminiClient, googleGenAiCtor = GoogleGenAI, sleep = delay } = {}) {
  if (!env.GEMINI_API_KEY) throw templateAiFailure("Template analysis is not configured: the primary API key is missing.", 503, false, "configuration_error");
  const model = env.GEMINI_TEMPLATE_MODEL || DEFAULTS.geminiModel;
  const thinkingLevel = env.GEMINI_TEMPLATE_THINKING_LEVEL || DEFAULTS.geminiThinking;
  const timeoutMs = boundedNumber(env.GEMINI_TEMPLATE_TIMEOUT_MS, DEFAULTS.geminiTimeoutMs, 10000, 120000);
  const maxOutputTokens = boundedNumber(env.GEMINI_TEMPLATE_MAX_OUTPUT_TOKENS, DEFAULTS.geminiMaxOutputTokens, 1200, 12000);
  const client = geminiClient || new googleGenAiCtor({ apiKey: env.GEMINI_API_KEY });
  const requestParams = {
    model,
    contents: JSON.stringify(normalized),
    config: {
      systemInstruction: buildExtractionSystemPrompt(normalized.mode),
      temperature: 0,
      maxOutputTokens,
      responseMimeType: 'application/json',
      responseJsonSchema: normalized.mode === 'context' ? templateContextOutputSchema.schema : templateMappingOutputSchema.schema,
      thinkingConfig: {
        thinkingLevel: THINKING_LEVELS[String(thinkingLevel).toLowerCase()] || ThinkingLevel.MEDIUM,
      },
      ...(signal ? { abortSignal: signal } : {}),
      httpOptions: { timeout: timeoutMs },
    },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await client.models.generateContent(requestParams);
      return { output: parseJson(response?.text), providerUsed: "gemini", modelUsed: model };
    } catch (error) {
      const failure = classifyGeminiFailure(error);
      if (attempt === 0 && failure.retry && !signal?.aborted) { await sleep(250); continue; }
      if (!failure.fallbackAllowed) console.warn("Gemini template extraction execution failed:", { name: error?.name || "Error", reason: failure.reason, status: statusFrom(error) || null, message: safeProviderMessage(error?.message, env) });
      throw templateAiFailure(
        failure.fallbackAllowed ? "The primary template-analysis provider is temporarily unavailable." : "Template analysis failed because of an application or configuration error.",
        statusFrom(error) || (failure.fallbackAllowed ? 503 : 500), failure.fallbackAllowed, failure.reason,
        { provider: "gemini", safeProviderMessage: safeProviderMessage(error?.message, env) },
      );
    }
  }
  throw templateAiFailure("The primary template-analysis provider is temporarily unavailable.", 503, true, "provider_unavailable");
}

export async function analyseWithOpenRouter(normalized, options = {}) {
  const env = options.env || process.env; const output = await requestOpenRouter(normalized, options);
  return { output, providerUsed: "openrouter", modelUsed: env.OPENROUTER_TEMPLATE_MODEL || DEFAULTS.openRouterModel };
}

export function normalizeProviderResult(providerResult, normalized) {
  const mapped = normalizeProviderOutput(providerResult.output, normalized);
  return { providerUsed: providerResult.providerUsed, modelUsed: providerResult.modelUsed, ...mapped };
}

export async function analyseTemplate(input, options = {}) {
  const normalized = normalizeAnalysisInput(input); const env = options.env || process.env;
  const primary = String(env.TEMPLATE_AI_PRIMARY || "gemini").toLowerCase(); const fallback = String(env.TEMPLATE_AI_FALLBACK || (primary === "gemini" ? "openrouter" : "gemini")).toLowerCase();
  const supported = new Set(["gemini", "openrouter"]);
  if (!supported.has(primary) || !supported.has(fallback)) throw templateAiFailure("Template AI provider configuration is invalid.", 503, false, "configuration_error");
  const modelFor = (provider) => provider === "gemini" ? env.GEMINI_TEMPLATE_MODEL || DEFAULTS.geminiModel : env.OPENROUTER_TEMPLATE_MODEL || DEFAULTS.openRouterModel;
  const run = (provider) => provider === "gemini" ? analyseWithGemini(normalized, options) : analyseWithOpenRouter(normalized, options);
  const diagnostics = { providerAttempted: primary, modelAttempted: modelFor(primary), providerRequestSent: false, providerReturnedFields: 0, acceptedFields: 0, fallbackUsed: false, fallbackReason: null, fallbackProvider: null, fallbackModel: null, localFallbackUsed: false, finalFields: 0 };
  let primaryFailure;
  try {
    diagnostics.providerRequestSent = true;
    const result = normalizeProviderResult(await run(primary), normalized);
    diagnostics.providerReturnedFields = result.diagnostics?.rawMappedFields ?? result.fields?.length ?? 0;
    diagnostics.acceptedFields = result.diagnostics?.acceptedMappedFields ?? result.fields?.length ?? 0;
    diagnostics.finalFields = result.fields?.length ?? 0;
    console.info('Template extraction diagnostics:', JSON.stringify(diagnostics));
    return { ...result, fallbackUsed: false, fallbackReason: null };
  } catch (error) {
    diagnostics.providerRequestSent = !error?.reason?.includes('configuration');
    if (!error?.retryable || fallback === primary) {
      console.warn('Template extraction failed (no fallback):', JSON.stringify({ ...diagnostics, failureReason: error?.reason || 'unknown' }));
      throw error;
    }
    primaryFailure = error;
  }
  diagnostics.fallbackUsed = true;
  diagnostics.fallbackReason = primaryFailure.reason || 'provider_unavailable';
  diagnostics.fallbackProvider = fallback;
  diagnostics.fallbackModel = modelFor(fallback);
  const result = normalizeProviderResult(await run(fallback), normalized);
  diagnostics.providerReturnedFields = result.diagnostics?.rawMappedFields ?? result.fields?.length ?? 0;
  diagnostics.acceptedFields = result.diagnostics?.acceptedMappedFields ?? result.fields?.length ?? 0;
  diagnostics.finalFields = result.fields?.length ?? 0;
  console.info('Template extraction diagnostics:', JSON.stringify(diagnostics));
  return { ...result, fallbackUsed: true, fallbackReason: primaryFailure.reason || "provider_unavailable" };
}

export async function mapFieldsWithAi(input, options = {}) {
  const evidence = normalizeMappingEvidence(input);
  const blocks = evidence.pagesOrSheets.flatMap((part, partIndex) => part.lines.map((line, index) => ({
    id: `block-${partIndex * 10000 + index}`, globalOrder: partIndex * 10000 + index, partOrder: index,
    type: line.blockType || "text_line", text: line.text, metadata: line, location: { partIndex },
  })));
  return analyseTemplate({ mode: "map", sourceType: evidence.sourceType, documentTitle: evidence.documentTitle, chunk: { id: "legacy-chunk", index: 0, blocks }, globalContext: {} }, options);
}

export { DEFAULTS as templateAiDefaults };
