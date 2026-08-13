import ExcelJS from "exceljs";
import { XMLParser } from "fast-xml-parser";
import { parseOffice } from "officeparser";

const SUPPORTED_TYPES = new Set(["docx", "pdf", "xlsx", "xml"]);
export const documentParseFailure = (message, status = 422, cause = null) => Object.assign(new Error(message), { status, code: "DOCUMENT_PARSE_FAILED", cause });
const text = (value) => String(value ?? "").normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
const plain = (value) => JSON.parse(JSON.stringify(value, (key, nested) => ["attachments", "rawContent"].includes(key) || typeof nested === "function" ? undefined : nested));

function normalizedDocument({ file, type, blocks, parts = [], metadata = {}, parser, extractionMethod = "text", warnings = [] }) {
  const ordered = blocks.filter((block) => text(block.text)).map((block, index) => ({ id: `block-${index}`, globalOrder: index, partOrder: Number.isInteger(block.partOrder) ? block.partOrder : index, type: block.type || "paragraph", text: text(block.text), metadata: plain(block.metadata || {}), location: plain(block.location || {}) }));
  const pick = (types) => ordered.filter((block) => types.has(block.type));
  return { fileName: String(file.originalname || `document.${type}`), fileType: type, mimeType: String(file.mimetype || ""), parser, extractionMethod, metadata: { ...plain(metadata), blockCount: ordered.length }, content: plain(type === "docx" && parts.length ? parts : ordered), parts: plain(parts), blocks: ordered, sections: pick(new Set(["heading", "section_heading"])), headings: pick(new Set(["heading", "section_heading"])), paragraphs: pick(new Set(["paragraph", "text_line", "xml_text"])), tables: pick(new Set(["table"])), rows: pick(new Set(["table_row", "spreadsheet_row"])), cells: pick(new Set(["table_cell", "spreadsheet_cell"])), lists: pick(new Set(["list_item"])), text: ordered.map((block) => block.text).join("\n"), ordering: ordered.map((block) => block.id), warnings };
}

function flattenOffice(content = []) {
  const blocks = [];
  const visit = (nodes, parents = [], inherited = {}) => {
    for (const node of nodes || []) {
      if (!node || typeof node !== "object") continue;
      const metadata = node.metadata && typeof node.metadata === "object" ? node.metadata : {};
      const location = { ...inherited, ...(Number.isInteger(metadata.pageNumber ?? metadata.page) ? { pageNumber: metadata.pageNumber ?? metadata.page } : {}), ...(Number.isInteger(metadata.row ?? metadata.rowIndex) ? { rowIndex: metadata.row ?? metadata.rowIndex } : {}), ...(Number.isInteger(metadata.col ?? metadata.columnIndex) ? { columnIndex: metadata.col ?? metadata.columnIndex } : {}) };
      const value = text(node.text); const type = String(node.type || "unknown");
      if (value && type !== "text") blocks.push({ type, text: value, metadata: { ...metadata, formatting: node.formatting || undefined, parentTypes: parents }, location });
      visit(node.children, [...parents, type], location); visit(node.notes, [...parents, type, "notes"], location); visit(node.comments, [...parents, type, "comments"], location);
    }
  };
  visit(content); return blocks;
}

async function parseDocx(file, options) {
  const ast = await (options.parser || parseOffice)(file.buffer, { fileType: "docx", extractAttachments: false, includeRawContent: false, abortSignal: options.signal });
  const structure = plain(ast); const blocks = flattenOffice(structure.content);
  return normalizedDocument({ file, type: "docx", blocks, parts: structure.content || [], metadata: structure.metadata || {}, parser: { package: "officeparser", sourceFormat: structure.type || "docx" } });
}

function pdfLines(items, pageNumber) {
  const rows = [];
  for (const item of items || []) {
    const value = text(item.str); if (!value) continue;
    const x = Number(item.transform?.[4]) || 0; const y = Number(item.transform?.[5]) || 0;
    let row = rows.find((entry) => Math.abs(entry.y - y) <= 3); if (!row) { row = { y, items: [] }; rows.push(row); }
    row.items.push({ value, x, width: Number(item.width) || 0, height: Number(item.height) || 0, fontName: item.fontName || "" });
  }
  return rows.sort((a, b) => b.y - a.y).map((row) => { const values = row.items.sort((a, b) => a.x - b.x); const maxHeight = Math.max(...values.map((item) => item.height), 0); return { type: "text_line", text: values.map((item) => item.value).join(" "), metadata: { x: values[0]?.x || 0, y: row.y, height: maxHeight, bold: values.some((item) => /bold/i.test(item.fontName)), fragments: values }, location: { pageNumber } }; });
}

async function defaultOcr(page, { signal, env = process.env } = {}) {
  const canvasModule = await import("@napi-rs/canvas");
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = canvasModule.DOMMatrix;
  const viewport = page.getViewport({ scale: 1.7 }); const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)); const context = canvas.getContext("2d");
  await page.render({ canvasContext: context, viewport }).promise;
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, { ...(env.TESSERACT_LANG_PATH ? { langPath: env.TESSERACT_LANG_PATH } : {}) });
  try { if (signal?.aborted) throw new DOMException("Extraction cancelled", "AbortError"); const result = await worker.recognize(canvas.toBuffer("image/png")); return String(result.data?.text || "").split(/\r?\n/).map(text).filter(Boolean); }
  finally { await worker.terminate(); }
}

async function parsePdf(file, options) {
  const canvasModule = await import("@napi-rs/canvas"); if (!globalThis.DOMMatrix) globalThis.DOMMatrix = canvasModule.DOMMatrix;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); const task = pdfjs.getDocument({ data: new Uint8Array(file.buffer), useSystemFonts: true, disableWorker: true }); const pdf = await task.promise;
  const blocks = []; const parts = []; let usedOcr = false;
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (options.signal?.aborted) throw new DOMException("Extraction cancelled", "AbortError");
      const page = await pdf.getPage(pageNumber); const content = await page.getTextContent(); let pageBlocks = pdfLines(content.items, pageNumber);
      const usableCharacters = pageBlocks.reduce((sum, block) => sum + block.text.replace(/\W/g, "").length, 0);
      if (usableCharacters < 20) { const lines = await (options.ocr || defaultOcr)(page, options); pageBlocks = lines.map((line) => ({ type: "text_line", text: line, metadata: { extraction: "ocr" }, location: { pageNumber } })); usedOcr = usedOcr || pageBlocks.length > 0; }
      blocks.push(...pageBlocks); parts.push({ name: `Page ${pageNumber}`, type: "page", pageNumber, blockCount: pageBlocks.length }); page.cleanup();
    }
  } finally { await task.destroy(); }
  if (!blocks.length) throw documentParseFailure("The PDF contains no usable text, and OCR produced no readable content.");
  return normalizedDocument({ file, type: "pdf", blocks, parts, metadata: { pageCount: pdf.numPages, ocrUsed: usedOcr }, parser: { package: "pdfjs-dist", ocr: usedOcr ? "tesseract.js" : null }, extractionMethod: usedOcr ? "ocr" : "text" });
}

const excelValue = (cell) => text(cell.text || cell.value?.text || cell.value?.result || cell.value);
async function parseXlsx(file, options) {
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(file.buffer); const blocks = []; const parts = [];
  workbook.eachSheet((sheet, sheetIndex) => {
    const merges = Object.keys(sheet._merges || {}); let partOrder = 0;
    sheet.eachRow({ includeEmpty: false }, (row, rowIndex) => {
      const maxColumn = Math.max(row.cellCount, sheet.columnCount); const cells = [];
      for (let columnIndex = 1; columnIndex <= maxColumn; columnIndex += 1) { const cell = row.getCell(columnIndex); const value = excelValue(cell); cells.push({ rowIndex, columnIndex, address: cell.address, displayedValue: value, empty: !value, validation: cell.dataValidation?.type ? { type: cell.dataValidation.type, formulae: cell.dataValidation.formulae || [], options: cell.dataValidation.formulae?.[0]?.split?.(",").map(text).filter(Boolean) || [] } : null, merged: cell.isMerged }); }
      const values = cells.filter((cell) => !cell.empty); if (!values.length) return;
      const mergedHeading = values.length === 1 && cells.some((cell) => cell.merged); const blockText = values.map((cell) => cell.displayedValue).join(" | ");
      blocks.push({ type: mergedHeading ? "heading" : "spreadsheet_row", text: blockText, partOrder: partOrder++, metadata: { sheetIndex: sheetIndex - 1, sheetName: sheet.name, rowIndex, cells, mergeRanges: merges, mergedHeading, emptyResponseCells: cells.filter((cell) => cell.empty).length }, location: { sheetIndex: sheetIndex - 1, sheetName: sheet.name, rowIndex } });
    });
    parts.push({ name: sheet.name, type: "worksheet", sheetIndex: sheetIndex - 1, rowCount: sheet.rowCount, columnCount: sheet.columnCount, mergeRanges: merges });
  });
  if (!blocks.length) throw documentParseFailure("The workbook contains no readable cells.");
  return normalizedDocument({ file, type: "xlsx", blocks, parts, metadata: { sheetCount: workbook.worksheets.length }, parser: { package: "exceljs" } });
}

const semanticXmlName = (name) => text(name).replace(/^.*:/, "");
async function parseXml(file) {
  const source = file.buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw documentParseFailure("XML declarations that can reference external entities are not accepted.", 400);
  let tree; try { tree = new XMLParser({ preserveOrder: true, ignoreAttributes: false, trimValues: true, parseTagValue: false, parseAttributeValue: false }).parse(source); } catch (error) { throw documentParseFailure("The XML file could not be parsed.", 422, error); }
  const blocks = []; const walk = (entries, path = "", depth = 0) => {
    for (const entry of entries || []) for (const [name, children] of Object.entries(entry)) {
      if (name === ":@" || name === "#text") continue;
      const currentPath = `${path}/${name}`; const list = Array.isArray(children) ? children : []; const direct = list.filter((item) => Object.hasOwn(item, "#text")).map((item) => text(item["#text"])).filter(Boolean).join(" "); const childTags = list.flatMap((item) => Object.keys(item).filter((key) => key !== ":@" && key !== "#text")); const semanticName = semanticXmlName(name);
      blocks.push({ type: childTags.length ? (depth <= 1 ? "heading" : "xml_element") : "xml_element", text: direct || semanticName, metadata: { semanticName, attributes: entry[":@"] || {}, empty: !direct && !childTags.length, childCount: childTags.length, depth }, location: { elementPath: currentPath } });
      if (direct) blocks.push({ type: "xml_text", text: direct, metadata: { semanticName, depth }, location: { elementPath: currentPath } });
      walk(list, currentPath, depth + 1);
    }
  }; walk(tree);
  if (!blocks.length) throw documentParseFailure("The XML file contains no readable elements.");
  return normalizedDocument({ file, type: "xml", blocks, parts: [{ name: "XML", type: "xml" }], metadata: {}, parser: { package: "fast-xml-parser" } });
}

export async function parseDocumentToJson(file, options = {}) {
  const type = String(options.sourceType || "").toLowerCase();
  if (!SUPPORTED_TYPES.has(type)) throw documentParseFailure("Only DOCX, PDF, XLSX and XML documents can be analysed.", 400);
  if (!file?.buffer?.length) throw documentParseFailure("A document file is required.", 400);
  try {
    if (type === "docx") return await parseDocx(file, options);
    if (type === "pdf") return await parsePdf(file, options);
    if (type === "xlsx") return await parseXlsx(file, options);
    return await parseXml(file, options);
  } catch (error) { if (error?.code === "DOCUMENT_PARSE_FAILED" || error?.name === "AbortError") throw error; throw documentParseFailure(`The uploaded ${type.toUpperCase()} document could not be converted to normalized structure.`, 422, error); }
}

export const supportedDocumentTypes = SUPPORTED_TYPES;
