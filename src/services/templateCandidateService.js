const HEADING_TYPES = new Set(["heading", "section_heading"]);
const INSTRUCTION = /^(?:note|instruction|guidance|warning|important)\b|\b(?:shall|must|should|ensure|refer to|do not|please read)\b/i;
const YES_NO = /(?:\bYES\s*[/|]\s*NO\b|\bYES\s+NO\b|\bY\s*[/|]\s*N\b)/i;
const CHECKBOX = /(?:☐|☑|□|✓|\[\s?\]|\bcheckbox\b)/i;
const BLANK = /(?:_{2,}|\.{4,}|-{4,})/;
const DATE = /\b(?:date|dd[\s/.-]*mm[\s/.-]*(?:yyyy|yy)|yyyy[\s/.-]*mm[\s/.-]*dd)\b/i;
const SIGNATURE = /\b(?:signature|signed by|master'?s sign|checked by\s*\(?sign\)?)\b/i;
const TEXTAREA = /\b(?:remarks?|comments?|observations?|description|details?|notes?)\b/i;
const NUMBER = /\b(?:quantity|q'?ty|pressure|press|temperature|temp|volume|weight|level|lv|reading|measurement|hours?|rate)\b/i;
const PHOTO = /\b(?:photo(?:graph)?|image)\b/i;

const cleanText = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const candidateLabel = (text) => cleanText(text)
  .replace(/(?:☐|☑|□|✓|\[\s?\])/g, " ")
  .replace(/\b(?:YES\s*[/|]?\s*NO|Y\s*[/|]\s*N)\b/ig, " ")
  .replace(/(?:_{2,}|\.{4,}|-{4,})/g, " ")
  .replace(/\s+/g, " ").trim();

function inferType(text, metadata = {}) {
  if (SIGNATURE.test(text)) return "signature";
  if (DATE.test(text)) return "date";
  if (YES_NO.test(text)) return "yes_no";
  if (PHOTO.test(text)) return "photo";
  if (TEXTAREA.test(text)) return "textarea";
  if (metadata?.validation?.type === "list") return "select";
  if (CHECKBOX.test(text)) return "checkbox";
  if (NUMBER.test(text)) return "number";
  return "text";
}

function rowSignal(block) {
  const cells = block.metadata?.cells || [];
  if (!cells.length) return false;
  const values = cells.map((cell) => cleanText(cell.displayedValue ?? cell.text ?? cell.value));
  return values.some(Boolean) && (values.some((value) => !value) || block.metadata?.emptyResponseCells > 0 || block.metadata?.tableStructure?.emptyResponseCells > 0);
}

function isLikelyField(block) {
  const text = cleanText(block.text);
  if (!text || HEADING_TYPES.has(block.type) || INSTRUCTION.test(text) && !YES_NO.test(text)) return false;
  if (block.type === "control") return true;
  if (rowSignal(block)) return true;
  if (block.type === "spreadsheet_row" && text.length <= 100 && (block.metadata?.cells || []).filter((cell) => cleanText(cell.displayedValue)).length === 1) return true;
  if (YES_NO.test(text) || CHECKBOX.test(text) || BLANK.test(text) || SIGNATURE.test(text)) return true;
  if (/^(?:inspection date|date|vessel name|imo(?: number)?|master'?s signature|remarks?|comments?|observations?)\s*:?[\s_*.-]*$/i.test(text)) return true;
  if (/^[^:]{2,100}:\s*(?:$|[_\s.\-]{2,})/.test(text)) return true;
  if (block.type === "xml_element" && block.metadata?.empty && block.metadata?.semanticName) return true;
  return false;
}

const headingLike = (block) => HEADING_TYPES.has(block.type)
  || Boolean(block.metadata?.headingLevel)
  || Boolean(block.metadata?.mergedHeading)
  || (/^[A-Z][A-Z\d &/()'-]{3,80}$/.test(cleanText(block.text)) && !YES_NO.test(block.text));

export function detectTemplateCandidates(document) {
  const blocks = document.blocks || [];
  const sections = [];
  const candidates = [];
  const classifications = [];
  let currentSection = { key: "general", title: "General", order: 0, evidenceRefs: [] };
  sections.push(currentSection);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]; const text = cleanText(block.text);
    if (!text) continue;
    if (headingLike(block)) {
      const title = text.replace(/[:_\s]+$/g, "").trim();
      if (title && title.length <= 160) {
        currentSection = { key: `section_${sections.length}`, title, order: block.globalOrder, evidenceRefs: [block.id] };
        sections.push(currentSection); classifications.push({ blockId: block.id, classification: "section", reason: "Structural heading" }); continue;
      }
    }
    const followedByBlank = text.length <= 120 && BLANK.test(cleanText(blocks[index + 1]?.text));
    const semanticTableLabel = /(?:table|spreadsheet)[_-]?(?:cell|row)/i.test(block.type) && text.length <= 120 && (DATE.test(text) || SIGNATURE.test(text) || TEXTAREA.test(text) || NUMBER.test(text));
    if (isLikelyField(block) || followedByBlank || semanticTableLabel) {
      const nearby = blocks.slice(Math.max(0, index - 2), Math.min(blocks.length, index + 3)).filter((item) => item.id !== block.id && item.text).map((item) => cleanText(item.text)).slice(0, 4);
      const cells = block.metadata?.cells || [];
      const firstMeaningfulCell = cells.find((cell) => cleanText(cell.displayedValue ?? cell.text ?? cell.value));
      let source = cleanText(firstMeaningfulCell?.displayedValue ?? firstMeaningfulCell?.text ?? text);
      if (block.type === "xml_element" && /^(?:value|input|field|answer)$/i.test(source)) { const previous = blocks[index - 1]; if (previous?.type === "xml_text" && cleanText(previous.text).length <= 120) source = cleanText(previous.text); }
      candidates.push({ id: `candidate-${candidates.length}`, blockId: block.id, sourceText: source, suggestedLabel: candidateLabel(source), suggestedType: inferType(text, firstMeaningfulCell || block.metadata), section: currentSection.title, sectionKey: currentSection.key, order: block.globalOrder, context: nearby, metadata: { blockType: block.type, location: block.location || {}, options: block.metadata?.options || firstMeaningfulCell?.validation?.options || [] } });
      classifications.push({ blockId: block.id, classification: "field", reason: "Deterministic form signal" });
    } else classifications.push({ blockId: block.id, classification: INSTRUCTION.test(text) ? "instruction" : "reference", reason: INSTRUCTION.test(text) ? "Instructional prose" : "No deterministic form signal" });
  }
  const meaningfulSections = sections.length > 1 ? sections.slice(1) : sections;
  return { sections: meaningfulSections, candidates, classifications };
}

export function fallbackFieldForCandidate(candidate) {
  return { candidateId: candidate.id, include: true, label: candidate.suggestedLabel, fieldType: candidate.suggestedType, section: candidate.section || "General", order: candidate.order, required: /\*/.test(candidate.sourceText), options: candidate.suggestedType === "yes_no" ? ["Yes", "No"] : candidate.metadata?.options || [] };
}
