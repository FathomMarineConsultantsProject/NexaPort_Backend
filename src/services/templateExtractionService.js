import { detectTemplateCandidates, fallbackFieldForCandidate } from "./templateCandidateService.js";
import { classifyCandidatesWithDeepSeek, resolveDeepSeekConfig } from "./deepSeekTemplateService.js";
import { parseDocumentToJson } from "./documentJsonService.js";
import { runTemplateQualityGate, sanitizeAndValidateFields, sanitizeTemplateLabel } from "./templateFieldSanitizer.js";

const compactCandidate = (candidate) => ({ id: candidate.id, sourceText: candidate.sourceText, suggestedLabel: candidate.suggestedLabel, suggestedType: candidate.suggestedType, order: candidate.order, context: candidate.context });

export function groupTemplateCandidates(candidates, sourceType, { maxCandidates = 60 } = {}) {
  if (candidates.length <= maxCandidates) return candidates.length ? [{ id: "chunk-0", section: candidates[0].section || "General", context: [...new Set(candidates.flatMap((item) => item.context))].slice(0, 12), candidates }] : [];
  const boundary = (candidate) => sourceType === "pdf" ? `page:${candidate.metadata?.location?.pageNumber || 0}` : sourceType === "xlsx" ? `sheet:${candidate.metadata?.location?.sheetName || candidate.metadata?.location?.sheetIndex || 0}` : sourceType === "xml" ? `section:${candidate.sectionKey}` : `section:${candidate.sectionKey}`;
  const groups = []; let current = null;
  for (const candidate of candidates) {
    const key = boundary(candidate);
    if (!current || current.candidates.length >= maxCandidates || current.key !== key && current.candidates.length >= Math.floor(maxCandidates / 2)) { current = { id: `chunk-${groups.length}`, key, section: candidate.section || "General", context: [], candidates: [] }; groups.push(current); }
    current.candidates.push(candidate); current.context.push(...candidate.context);
  }
  return groups.map(({ key: _key, ...group }) => ({ ...group, context: [...new Set(group.context)].slice(0, 12) }));
}

const fallbackChunk = (chunk) => chunk.candidates.map(fallbackFieldForCandidate);

export async function runTemplateExtraction(file, { sourceType, signal, env = process.env, fetchImpl = globalThis.fetch, parseDocument = parseDocumentToJson, classifyCandidates = classifyCandidatesWithDeepSeek, parserOptions = {} } = {}) {
  const started = Date.now(); const document = await parseDocument(file, { sourceType, signal, env, ...parserOptions });
  const detection = detectTemplateCandidates(document); const chunks = groupTemplateCandidates(detection.candidates, sourceType);
  const rawFields = []; const warnings = [...(document.warnings || [])]; let degraded = false; let aiAttempts = 0; let modelUsed = null;
  for (const chunk of chunks) {
    const payload = { section: chunk.section, context: chunk.context, candidates: chunk.candidates.map(compactCandidate) };
    try {
      const classified = await classifyCandidates(payload, { env, fetchImpl, signal }); aiAttempts += classified.attempts || 1; modelUsed = classified.modelUsed || modelUsed;
      rawFields.push(...classified.fields); warnings.push(...(classified.warnings || []));
      const returned = new Set(classified.fields.map((field) => field.candidateId));
      for (const candidate of chunk.candidates) if (!returned.has(candidate.id)) { rawFields.push(fallbackFieldForCandidate(candidate)); degraded = true; warnings.push(`Candidate ${candidate.id} was omitted from structured output and was recovered deterministically.`); }
    } catch (error) {
      if (signal?.aborted) throw error;
      degraded = true; aiAttempts += Number(error?.attempts || 0); rawFields.push(...fallbackChunk(chunk)); warnings.push(`DeepSeek unavailable for ${chunk.id}; deterministic extraction was used (${error?.reason || "provider_unavailable"}).`);
    }
  }
  let sanitized = sanitizeAndValidateFields(rawFields, detection.candidates); let quality = runTemplateQualityGate({ fields: sanitized.fields, candidates: detection.candidates, sections: detection.sections });
  if (!quality.passed && detection.candidates.length) {
    degraded = true; sanitized = sanitizeAndValidateFields(detection.candidates.map(fallbackFieldForCandidate), detection.candidates); quality = runTemplateQualityGate({ fields: sanitized.fields, candidates: detection.candidates, sections: detection.sections });
  }
  if (!quality.passed) throw Object.assign(new Error(`Template extraction quality gate failed: ${quality.issues.join(" ")}`), { status: 422, code: "TEMPLATE_QUALITY_GATE_FAILED", stage: "quality_gate" });
  const sectionMap = new Map();
  for (const source of detection.sections) { const title = sanitizeTemplateLabel(source.title); if (title) sectionMap.set(title.toLowerCase(), { sectionKey: source.key, title, order: source.order, evidenceRefs: source.evidenceRefs }); }
  for (const field of sanitized.fields) if (!sectionMap.has(field.section.toLowerCase())) sectionMap.set(field.section.toLowerCase(), { sectionKey: field.sectionKey, title: field.section, order: field.sourceOrder, evidenceRefs: field.evidenceRefs.slice(0, 1) });
  const sections = [...sectionMap.values()].sort((a, b) => a.order - b.order);
  return { documentTitle: document.fileName.replace(/\.[^.]+$/, ""), sourceType, extractionMethod: document.extractionMethod, sections, fields: sanitized.fields, classifications: detection.classifications, warnings, unmappedBlocks: detection.classifications.filter((item) => item.classification === "reference"), degraded, incomplete: degraded, diagnostics: { parser: document.parser, parsedBlocks: document.blocks.length, candidateCount: detection.candidates.length, chunkCount: chunks.length, aiAttempts, modelUsed: modelUsed || (env.OPENROUTER_API_KEY ? resolveDeepSeekConfig(env).primaryModel : null), rejectedFields: sanitized.rejected.length, qualityGate: quality.passed, durationMs: Date.now() - started, normalized: { sections: document.sections.length, headings: document.headings.length, paragraphs: document.paragraphs.length, rows: document.rows.length, cells: document.cells.length, lists: document.lists.length } } };
}
