import { z } from "zod";
import { SUPPORTED_TEMPLATE_FIELD_TYPES } from "./templateFieldSanitizer.js";

const DEFAULT_PRIMARY = "deepseek/deepseek-chat:free";
const DEFAULT_SECONDARY = "deepseek/deepseek-chat";
const outputSchema = z.object({ fields: z.array(z.object({
  candidateId: z.string(), include: z.boolean(), label: z.string(),
  fieldType: z.enum(SUPPORTED_TEMPLATE_FIELD_TYPES), section: z.string(),
  order: z.number().int().nonnegative(), required: z.boolean(), options: z.array(z.string()),
  })), warnings: z.array(z.string()).default([]) });

const jsonSchema = {
  name: "nexaport_template_candidates", strict: true,
  schema: { type: "object", additionalProperties: false, required: ["fields", "warnings"], properties: {
    fields: { type: "array", items: { type: "object", additionalProperties: false, required: ["candidateId", "include", "label", "fieldType", "section", "order", "required", "options"], properties: {
      candidateId: { type: "string" }, include: { type: "boolean" }, label: { type: "string" }, fieldType: { enum: SUPPORTED_TEMPLATE_FIELD_TYPES }, section: { type: "string" }, order: { type: "integer", minimum: 0 }, required: { type: "boolean" }, options: { type: "array", items: { type: "string" } },
    } } }, warnings: { type: "array", items: { type: "string" } },
  } },
};

const prompt = `Classify deterministic field candidates from a maritime form. Code has already detected structure and supplies category, majorSection, subSection, tableHeaders, signals and nearby context. For each candidate, decide whether it is genuinely user-entered data, clean its semantic label, confirm one supported field type, section, and order. Checklist questions signalled as yes_no or not_applicable must remain checklist-compatible (yes_no or select), never text. Treat Part A/Part B/B1/C2 identifiers, table headings such as Time/Tank/Status/Code, instructions and ordinary prose as non-fields. Do not invent fields or expose block IDs, spreadsheet coordinates, XML paths, parser tags or provenance. Keep candidateId unchanged and return only the required JSON schema.`;
const bounded = (value, fallback, min, max) => { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback; };
const deepSeekModel = (value, fallback) => {
  const model = String(value || fallback).trim();
  if (!/^deepseek\//i.test(model)) throw Object.assign(new Error("Template extraction models must be DeepSeek routes through OpenRouter."), { code: "TEMPLATE_AI_CONFIGURATION", status: 503 });
  return model;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reasonFor = (status, error) => status === 402 ? "payment_required" : status === 403 ? "access_denied" : status === 429 ? "rate_limited" : status >= 500 ? "provider_unavailable" : error?.name === "TimeoutError" ? "timeout" : "provider_error";

async function oneRequest(payload, model, { env, fetchImpl, signal }) {
  const timeoutMs = bounded(env.OPENROUTER_TEMPLATE_TIMEOUT_MS, 45000, 5000, 120000);
  const timeout = AbortSignal.timeout(timeoutMs); const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", { method: "POST", signal: combined, headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, temperature: 0, max_tokens: bounded(env.OPENROUTER_TEMPLATE_MAX_OUTPUT_TOKENS, 6000, 1200, 12000), reasoning: { effort: env.OPENROUTER_TEMPLATE_REASONING_EFFORT || "low" }, provider: { require_parameters: true, zdr: true }, response_format: { type: "json_schema", json_schema: jsonSchema }, messages: [{ role: "system", content: prompt }, { role: "user", content: JSON.stringify(payload) }] }) });
  } catch (error) {
    const timeoutFailure = timeout.aborted && !signal?.aborted;
    throw Object.assign(new Error(timeoutFailure ? "OpenRouter template analysis timed out." : "OpenRouter template analysis is unavailable."), { status: 503, reason: timeoutFailure ? "timeout" : "network_error", retryable: !timeoutFailure, provider: "openrouter", cause: error });
  }
  if (!response.ok) {
    const status = response.status; const reason = reasonFor(status);
    throw Object.assign(new Error(status === 402 ? "OpenRouter credits are insufficient." : status === 403 ? "The configured DeepSeek route is unavailable." : status === 429 ? "OpenRouter is rate limited." : "OpenRouter template analysis failed."), { status: [402,403,429].includes(status) ? status : 503, providerStatus: status, reason, retryable: status === 429 || status >= 500, provider: "openrouter" });
  }
  let body; try { body = await response.json(); } catch { throw Object.assign(new Error("OpenRouter returned malformed JSON."), { status: 502, reason: "invalid_response" }); }
  let content = body?.choices?.[0]?.message?.content;
  if (typeof content === "string") { try { content = JSON.parse(content); } catch { throw Object.assign(new Error("DeepSeek returned malformed structured output."), { status: 502, reason: "invalid_response" }); } }
  const parsed = outputSchema.safeParse(content);
  if (!parsed.success) throw Object.assign(new Error("DeepSeek returned unsupported structured output."), { status: 502, reason: "invalid_response" });
  return parsed.data;
}

export function resolveDeepSeekConfig(env = process.env) {
  return { primaryModel: deepSeekModel(env.OPENROUTER_TEMPLATE_MODEL, DEFAULT_PRIMARY), fallbackModel: deepSeekModel(env.OPENROUTER_TEMPLATE_FALLBACK_MODEL, DEFAULT_SECONDARY), reasoningEffort: env.OPENROUTER_TEMPLATE_REASONING_EFFORT || "low", maxAttempts: 3 };
}

export async function classifyCandidatesWithDeepSeek(payload, { env = process.env, fetchImpl = globalThis.fetch, signal, sleep = wait } = {}) {
  if (!env.OPENROUTER_API_KEY) throw Object.assign(new Error("OpenRouter API key is missing."), { status: 503, reason: "configuration_error", attempts: 0 });
  const config = resolveDeepSeekConfig(env); let attempts = 0; let primaryError;
  try {
    attempts += 1; return { ...(await oneRequest(payload, config.primaryModel, { env, fetchImpl, signal })), modelUsed: config.primaryModel, attempts };
  } catch (error) {
    primaryError = error;
    if (error.reason === "payment_required" || error.reason === "invalid_response" || error.providerStatus === 400 || error.providerStatus === 401 || signal?.aborted) throw Object.assign(error, { attempts });
    if (error.retryable) {
      await sleep(250);
      try { attempts += 1; return { ...(await oneRequest(payload, config.primaryModel, { env, fetchImpl, signal })), modelUsed: config.primaryModel, attempts }; }
      catch (retryError) {
        primaryError = retryError;
        if (retryError.reason === "payment_required" || retryError.reason === "invalid_response" || retryError.providerStatus === 400 || retryError.providerStatus === 401 || signal?.aborted) throw Object.assign(retryError, { attempts });
      }
    }
  }
  if (config.fallbackModel !== config.primaryModel && attempts < config.maxAttempts) {
    try { attempts += 1; return { ...(await oneRequest(payload, config.fallbackModel, { env, fetchImpl, signal })), modelUsed: config.fallbackModel, attempts }; }
    catch (error) { throw Object.assign(error, { attempts, primaryReason: primaryError?.reason }); }
  }
  throw Object.assign(primaryError, { attempts });
}

export const deepSeekTemplateOutputSchema = outputSchema;
