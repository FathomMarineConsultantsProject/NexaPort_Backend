import { analyseTemplateSource, normalizeAnalysisInput, normalizeMappingEvidence } from "./openRouterTemplateService.js";

// Compatibility layer for the legacy map-fields endpoint. Template extraction
// has exactly one gateway: DeepSeek models reached through OpenRouter.
export async function analyseTemplate(input, options = {}) {
  return { ...(await analyseTemplateSource(normalizeAnalysisInput(input), options)), providerUsed: "openrouter", modelUsed: (options.env || process.env).OPENROUTER_TEMPLATE_MODEL || "deepseek/deepseek-chat:free", fallbackUsed: false, fallbackReason: null };
}

export async function mapFieldsWithAi(input, options = {}) {
  const evidence = normalizeMappingEvidence(input);
  const blocks = evidence.pagesOrSheets.flatMap((part, partIndex) => part.lines.map((line, index) => ({ id: `block-${partIndex * 10000 + index}`, globalOrder: partIndex * 10000 + index, partOrder: index, type: line.blockType || "text_line", text: line.text, metadata: line, location: { partIndex } })));
  return analyseTemplate({ mode: "map", sourceType: evidence.sourceType, documentTitle: evidence.documentTitle, chunk: { id: "legacy-chunk", index: 0, blocks }, globalContext: {} }, options);
}
