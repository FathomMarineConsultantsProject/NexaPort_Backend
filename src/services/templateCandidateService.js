const HEADING_TYPES = new Set(["heading", "section_heading"]);
const INSTRUCTION = /^(?:note|instruction|guidance|warning|important)\b|\b(?:shall|must|should|ensure|refer to|do not|please read)\b/i;
const YES_NO = /(?:\bYES\s*[/|]\s*NO\b|\bYES\s+NO\b|\bY\s*[/|]\s*N\b|\bYes\b.*\bNot applicable\b)/i;
const CHECKBOX = /(?:☐|☑|□|✓||\[\s?\]|\bcheckbox\b)/i;
const BLANK = /(?:_{2,}|\.{4,}|-{4,})/;
const DATE = /\b(?:date(?:\s+and\s+time)?|dd[\s/.-]*mm[\s/.-]*(?:yyyy|yy)|yyyy[\s/.-]*mm[\s/.-]*dd)\b/i;
const SIGNATURE = /\b(?:signature|signed by|master'?s sign|checked by\s*\(?sign\)?)\b/i;
const TEXTAREA = /\b(?:remarks?|comments?|observations?|description|details?|notes?)\b/i;
const NUMBER = /\b(?:quantity|q'?ty|pressure|press|temperature|temp|volume|weight|level|reading|measurement|hours?|rate|capacity|limit|percentage|percent|o2|oxygen|flow)\b/i;
const PHOTO = /\b(?:photo(?:graph)?|image)\b/i;
const PART_REFERENCE = /^(?:part\s*)?[A-F](?:\d+)?\s*:?(?:\s*[-–—]\s*)?$/i;
const SUBSECTION = /^(?:part\s*)?([A-F]\d+)\s*:?(?:\s*[-–—]\s*(.+))?$/i;
const MAJOR = /^(?:part\s*)?([A-F])\s*[:–—-]\s*(.+)$/i;
const TABLE_HEADER = /^(?:no\.?|item|check|status|code|remarks?|time|tank|description|agreement|reference(?:\s+to\s+check)?|bunker vessel|receiving vessel|berth(?: operator)?|position|signature|date(?:\s+and\s+time)?)$/i;
const MAJOR_TITLES = { A: "Preparation", B: "Pre-operation", C: "Alignment and Agreement", D: "Connection Testing", E: "Transfer", F: "Post Operation" };

const cleanText = (value) => String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const candidateLabel = (value) => cleanText(value)
  .replace(/^(?:\d+|[A-F]\d+(?:-\d+)?)\s*[|.)-]\s*/i, "")
  .replace(/(?:☐|☑|□|✓||\[\s?\])/g, " ")
  .replace(/\b(?:YES\s*[/|]?\s*NO|Y\s*[/|]\s*N|Not applicable|Agreed)\b/ig, " ")
  .replace(/(?:_{2,}|\.{4,}|-{4,})/g, " ").replace(/\s+/g, " ").trim();

function inferType(value, metadata = {}) {
  const source = cleanText(value);
  if (SIGNATURE.test(source)) return "signature";
  if (DATE.test(source)) return "date";
  if (YES_NO.test(source)) return "yes_no";
  if (PHOTO.test(source)) return "photo";
  if (TEXTAREA.test(source)) return "textarea";
  if (metadata?.validation?.type === "list") return "select";
  if (CHECKBOX.test(source)) return "checkbox";
  if (NUMBER.test(source)) return "number";
  return "text";
}

const cellValues = (block) => (block.metadata?.cells || []).map((cell) => cleanText(cell.displayedValue ?? cell.text ?? cell.value));
const isHeaderRow = (values) => {
  const meaningful = values.filter(Boolean);
  if (!meaningful.length) return false;
  if (/^(?:[A-F]\d+|no\.?)$/i.test(meaningful[0]) && meaningful.slice(1).filter((value) => TABLE_HEADER.test(value)).length >= 1) return true;
  return meaningful.length >= 2 && meaningful.filter((value) => TABLE_HEADER.test(value)).length / meaningful.length >= 0.6;
};
const tableQuestion = (values, headers = []) => {
  const descriptionIndex = headers.findIndex((value) => /^description$/i.test(value));
  if (descriptionIndex >= 0 && values[descriptionIndex]) return values[descriptionIndex];
  if (/^(?:\d+|[A-F]\d+-\d+)$/i.test(values[0] || "") && values[1]) return values[1];
  return values.find((value, index) => index > 0 && value.length > 5 && !TABLE_HEADER.test(value) && !/^(?:yes|no|agreed|not applicable|[A-Z]\s*-\s*[A-Z])$/i.test(value)) || values[0] || "";
};
const checklistSignal = (values, headers = []) => {
  const joined = values.join(" ");
  return YES_NO.test(joined) || CHECKBOX.test(joined) && /\b(?:yes|agreed|not applicable)\b/i.test(joined)
    || headers.some((value) => /^(?:check|status|time)$/i.test(value)) && /^(?:\d+|[A-F]\d+-\d+)$/i.test(values[0] || "");
};

function hierarchyForHeading(value) {
  const source = cleanText(value); const major = source.match(MAJOR); const sub = source.match(SUBSECTION);
  if (sub) return { kind: "subsection", code: sub[1].toUpperCase(), title: cleanText(sub[2]) };
  if (major) {
    const code = major[1].toUpperCase(); const rawTitle = cleanText(major[2]);
    const canonical = MAJOR_TITLES[code];
    const isMajorOnly = new RegExp(`${canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[- ]")}\\s*(?:phase)?$`, "i").test(rawTitle);
    return { kind: isMajorOnly ? "major" : "major_detail", code, majorTitle: canonical, title: isMajorOnly ? canonical : rawTitle.replace(/\s+phase$/i, "") };
  }
  if (/^declaration\b/i.test(source)) return { kind: "declaration", title: source };
  return null;
}

function explicitFieldSignal(block, source) {
  if (block.type === "control" || block.type === "xml_element" && block.metadata?.empty) return true;
  if (YES_NO.test(source) || CHECKBOX.test(source) || BLANK.test(source) || SIGNATURE.test(source)) return true;
  if (/^(?:inspection date|date(?: and time)?|vessel name|imo(?: number)?|master'?s signature|remarks?|comments?|observations?|name|position|berth representative|jpbo version number|bunker identification number(?: \(bin\))?)\s*:?/i.test(source)) return true;
  return /^[^:]{2,100}:\s*(?:$|[_\s.\-]{2,})/.test(source);
}

export function detectTemplateCandidates(document) {
  const blocks = document.blocks || []; const sections = []; const candidates = []; const classifications = [];
  let majorSection = "General"; let subSection = ""; let currentSection = "General"; let tableHeaders = []; let currentTable = null;
  const addSection = (title, order, ref, code = "") => {
    const clean = cleanText(title); if (!clean || sections.some((section) => section.title === clean)) return;
    sections.push({ key: code ? `section_${code.toLowerCase()}` : `section_${sections.length}`, title: clean, order, evidenceRefs: [ref], majorSection, subSection: code || undefined });
  };
  const addCandidate = (block, source, category, signals, forcedType = null, suffix = "") => {
    const label = candidateLabel(source); if (!label || PART_REFERENCE.test(label) || TABLE_HEADER.test(label)) return;
    const nearby = blocks.slice(Math.max(0, block.globalOrder - 2), Math.min(blocks.length, block.globalOrder + 3)).filter((item) => item.id !== block.id && item.text).map((item) => cleanText(item.text)).slice(0, 4);
    candidates.push({ id: `candidate-${candidates.length}`, blockId: block.id, sourceText: cleanText(source), suggestedLabel: label, suggestedType: forcedType || inferType(`${source} ${signals.join(" ")}`), section: currentSection, sectionKey: `section_${currentSection.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, majorSection, subSection, tableHeaders: [...tableHeaders], category, signals, forcedType, forcedInclude: ["checklist_item", "data_entry", "declaration_field"].includes(category), order: block.globalOrder * 10 + candidates.length % 10, context: nearby, metadata: { blockType: block.type, location: block.location || {}, options: forcedType === "select" ? ["Yes", "No", "Not Applicable"] : [], suffix } });
  };

  for (const block of blocks) {
    const source = cleanText(block.text); if (!source) continue;
    const hierarchy = HEADING_TYPES.has(block.type) ? hierarchyForHeading(source) : null;
    if (hierarchy) {
      if (hierarchy.kind === "major" || hierarchy.kind === "major_detail") {
        majorSection = hierarchy.majorTitle || hierarchy.title; subSection = ""; currentSection = majorSection; addSection(majorSection, block.globalOrder, block.id);
        if (hierarchy.kind === "major_detail") { subSection = hierarchy.code; currentSection = `${majorSection} — ${hierarchy.title}`; addSection(currentSection, block.globalOrder + 0.1, block.id, hierarchy.code); }
      } else if (hierarchy.kind === "subsection") {
        majorSection = MAJOR_TITLES[hierarchy.code[0]] || majorSection; subSection = hierarchy.code;
        currentSection = hierarchy.title ? `${subSection} — ${hierarchy.title}` : `${majorSection} — ${subSection}`; addSection(majorSection, block.globalOrder, block.id); addSection(currentSection, block.globalOrder + 0.1, block.id, subSection);
      } else {
        majorSection = "Declarations"; subSection = ""; addSection("Declarations", block.globalOrder, block.id);
        const detail = hierarchy.title.replace(/^declaration(?:\s+on)?\s*/i, "").trim(); currentSection = detail ? `Declarations — ${detail}` : "Declarations";
        if (detail) addSection(currentSection, block.globalOrder + 0.1, block.id);
      }
      classifications.push({ blockId: block.id, classification: "section", category: "section_heading", reason: "Semantic document hierarchy" }); continue;
    }
    if (HEADING_TYPES.has(block.type) || PART_REFERENCE.test(source)) {
      if (HEADING_TYPES.has(block.type) && !PART_REFERENCE.test(source) && source.length <= 120) { subSection = ""; currentSection = source; addSection(currentSection, block.globalOrder, block.id); classifications.push({ blockId: block.id, classification: "section", category: "section_heading", reason: "Structural heading" }); }
      else classifications.push({ blockId: block.id, classification: "reference", category: "section_identifier", reason: "Navigation or structural identifier" });
      continue;
    }

    if (block.type === "table_row" || block.type === "spreadsheet_row") {
      const values = cellValues(block); const tableId = block.metadata?.tableIndex ?? block.location?.sheetName ?? "table";
      if (tableId !== currentTable) { currentTable = tableId; tableHeaders = []; }
      const declarationLabel = values.find((value) => /^(?:name|position|signature|date(?: and time)?)$/i.test(value));
      if (declarationLabel && (majorSection === "Declarations" || /declaration/i.test(currentSection))) {
        const parties = tableHeaders.filter((value) => /vessel|berth/i.test(value)).slice(0, Math.max(1, values.filter(Boolean).length));
        const count = Math.max(1, parties.length || values.filter((value) => new RegExp(`^${declarationLabel}$`, "i").test(value)).length);
        for (let index = 0; index < count; index += 1) addCandidate(block, `${parties[index] ? `${parties[index]} ` : ""}${declarationLabel}`, "declaration_field", ["declaration", `table:${tableId}`], inferType(declarationLabel), String(index));
        classifications.push({ blockId: block.id, classification: "field", category: "declaration_field", reason: "Declaration sign-off row" }); continue;
      }
      if (isHeaderRow(values)) {
        tableHeaders = values.filter(Boolean); const tableCode = tableHeaders[0]?.match(/^([A-F]\d+)$/i)?.[1]?.toUpperCase();
        if (tableCode && tableCode !== subSection) { const detail = currentSection.replace(/^[A-F]\d+\s*—\s*/i, ""); majorSection = MAJOR_TITLES[tableCode[0]] || majorSection; subSection = tableCode; currentSection = `${tableCode} — ${detail || majorSection}`; addSection(currentSection, block.globalOrder, block.id, tableCode); }
        classifications.push({ blockId: block.id, classification: "reference", category: "table_header", reason: "Table header row" }); continue;
      }
      if (checklistSignal(values, tableHeaders)) {
        const question = tableQuestion(values, tableHeaders); const hasNA = values.some((value) => /not applicable|\bN\/?A\b/i.test(value));
        addCandidate(block, question, "checklist_item", ["checkbox", hasNA ? "not_applicable" : "yes_no", `table:${tableId}`], hasNA ? "select" : "yes_no");
        classifications.push({ blockId: block.id, classification: "field", category: "checklist_item", reason: "Checklist response row" }); continue;
      }
      const meaningful = values.filter(Boolean); const first = values[0] || ""; const second = values[1] || "";
      const numbered = /^(?:\d+|[A-F]\d+-\d+)$/i.test(first);
      const nextBlock = blocks[block.globalOrder + 1]; const nextValues = nextBlock?.metadata?.tableIndex === block.metadata?.tableIndex ? cellValues(nextBlock) : [];
      if (/^[A-F]\d+-\d+$/i.test(first) && second && CHECKBOX.test(nextValues.join(" ")) && /\bagreed\b/i.test(nextValues.join(" "))) {
        addCandidate(block, second, "checklist_item", ["agreement", `table:${tableId}`], "yes_no");
        classifications.push({ blockId: block.id, classification: "field", category: "checklist_item", reason: "Agreement row followed by party checkboxes" }); continue;
      }
      const label = numbered ? tableQuestion(values, tableHeaders) : first;
      const blankAdjacent = values.slice(1).some((value) => !value || BLANK.test(value)) || block.metadata?.emptyResponseCells > 0;
      const semanticLabel = label && !TABLE_HEADER.test(label) && !PART_REFERENCE.test(label);
      if (semanticLabel && (blankAdjacent || numbered || /:\s*$/.test(label))) {
        addCandidate(block, label, "data_entry", [blankAdjacent ? "blank_adjacent_cell" : "table_value", `table:${tableId}`], inferType(label));
        classifications.push({ blockId: block.id, classification: "field", category: "data_entry", reason: "Table label with response area" }); continue;
      }
      classifications.push({ blockId: block.id, classification: "reference", category: "table_content", reason: "Non-input table content" }); continue;
    }

    tableHeaders = []; currentTable = null;
    if (explicitFieldSignal(block, source) && source.length <= 100 && !/^(?:we|the|if)\b/i.test(source) && !(INSTRUCTION.test(source) && !YES_NO.test(source))) {
      addCandidate(block, source, majorSection === "Declarations" ? "declaration_field" : "data_entry", ["explicit_form_signal"]);
      classifications.push({ blockId: block.id, classification: "field", category: "data_entry", reason: "Explicit form signal" });
    } else classifications.push({ blockId: block.id, classification: INSTRUCTION.test(source) ? "instruction" : "reference", category: INSTRUCTION.test(source) ? "instructional_text" : "ordinary_prose", reason: INSTRUCTION.test(source) ? "Instructional prose" : "No deterministic form signal" });
  }
  return { sections, candidates, classifications };
}

export function fallbackFieldForCandidate(candidate) {
  return { candidateId: candidate.id, include: true, label: candidate.suggestedLabel, fieldType: candidate.forcedType || candidate.suggestedType, section: candidate.section || "General", order: candidate.order, required: /\*/.test(candidate.sourceText), options: candidate.forcedType === "select" ? ["Yes", "No", "Not Applicable"] : candidate.suggestedType === "yes_no" ? ["Yes", "No"] : candidate.metadata?.options || [] };
}
