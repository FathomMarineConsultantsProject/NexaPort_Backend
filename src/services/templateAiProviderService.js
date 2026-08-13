import { GoogleGenAI } from "@google/genai";
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

const boundedNumber = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const statusFrom = (error) => Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.cause?.status ?? 0);
const errorCode = (error) => String(error?.code ?? error?.cause?.code ?? "").toUpperCase();
const errorMessage = (error) => String(error?.message ?? error?.cause?.message ?? "").toLowerCase();

export function classifyGeminiFailure(error) {
  const status = statusFrom(error); const code = errorCode(error); const message = errorMessage(error);
  if (status === 429 || code === "RESOURCE_EXHAUSTED" || /resource[_ ]exhausted|quota (?:exhausted|temporarily)|rate[ -]?limit/.test(message)) return { reason: "rate_limited", fallbackAllowed: true, retry: false };
  if (status >= 500 || /service unavailable|temporar(?:y|ily) unavailable/.test(message)) return { reason: "provider_unavailable", fallbackAllowed: true, retry: true };
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH"].includes(code) || error?.name === "TimeoutError" || error?.name === "AbortError" && error?.templateTimeout || /network error|fetch failed|timed out|timeout/.test(message)) return { reason: error?.name === "TimeoutError" || /timed out|timeout/.test(message) ? "timeout" : "network_error", fallbackAllowed: true, retry: true };
  if (status === 401 || status === 403 || ["UNAUTHENTICATED", "API_KEY_INVALID"].includes(code) || /api key.*(?:invalid|not valid)|authentication|unauthenticated|permission denied/.test(message)) return { reason: "authentication_error", fallbackAllowed: false, retry: false };
  return { reason: "application_error", fallbackAllowed: false, retry: false };
}

const parseJson = (value) => {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(String(value ?? "")); }
  catch { throw templateAiFailure("The configured template-analysis model returned malformed JSON.", 502, false, "invalid_response"); }
};

const interactionResponseSchema = (mode) => ({ type: "text", mime_type: "application/json", schema: mode === "context" ? templateContextOutputSchema.schema : templateMappingOutputSchema.schema });

export async function analyseWithGemini(normalized, { env = process.env, signal, geminiClient, sleep = delay } = {}) {
  if (!env.GEMINI_API_KEY) throw templateAiFailure("Template analysis is not configured: the primary API key is missing.", 503, false, "configuration_error");
  const model = env.GEMINI_TEMPLATE_MODEL || DEFAULTS.geminiModel;
  const thinkingLevel = env.GEMINI_TEMPLATE_THINKING_LEVEL || DEFAULTS.geminiThinking;
  const timeoutMs = boundedNumber(env.GEMINI_TEMPLATE_TIMEOUT_MS, DEFAULTS.geminiTimeoutMs, 10000, 120000);
  const maxOutputTokens = boundedNumber(env.GEMINI_TEMPLATE_MAX_OUTPUT_TOKENS, DEFAULTS.geminiMaxOutputTokens, 1200, 12000);
  const client = geminiClient || new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const request = {
    model,
    system_instruction: templateAiPrompts[normalized.mode],
    input: JSON.stringify(normalized),
    response_format: interactionResponseSchema(normalized.mode),
    generation_config: { thinking_level: thinkingLevel, max_output_tokens: maxOutputTokens },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await client.interactions.create(request, { timeout: timeoutMs, maxRetries: 0, fetchOptions: signal ? { signal } : undefined });
      return { output: parseJson(response?.output_text), providerUsed: "gemini", modelUsed: model };
    } catch (error) {
      const failure = classifyGeminiFailure(error);
      if (attempt === 0 && failure.retry && !signal?.aborted) { await sleep(250); continue; }
      throw templateAiFailure(
        failure.fallbackAllowed ? "The primary template-analysis provider is temporarily unavailable." : "Template analysis failed because of an application or configuration error.",
        statusFrom(error) || (failure.fallbackAllowed ? 503 : 500), failure.fallbackAllowed, failure.reason,
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
  const primary = env.TEMPLATE_AI_PRIMARY || "gemini"; const fallback = env.TEMPLATE_AI_FALLBACK || "openrouter";
  if (primary !== "gemini") throw templateAiFailure("TEMPLATE_AI_PRIMARY must be gemini.", 503, false, "configuration_error");
  let primaryFailure;
  try {
    const result = normalizeProviderResult(await analyseWithGemini(normalized, options), normalized);
    return { ...result, fallbackUsed: false, fallbackReason: null };
  } catch (error) {
    if (!error?.retryable || fallback !== "openrouter") throw error;
    primaryFailure = error;
  }
  const result = normalizeProviderResult(await analyseWithOpenRouter(normalized, options), normalized);
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
