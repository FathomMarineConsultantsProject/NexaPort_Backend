import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { zipSync, strToU8 } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { parseDocumentToJson } from "../src/services/documentJsonService.js";
import { runTemplateExtraction } from "../src/services/templateExtractionService.js";
import { isProvenanceOnlyLabel } from "../src/utils/templateProvenance.js";

const contentTypes = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const rootRels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const p = (value, heading = false) => `<w:p>${heading ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : ""}<w:r><w:t>${value}</w:t></w:r></w:p>`;
const row = (...values) => `<w:tr>${values.map((value) => `<w:tc>${p(value)}</w:tc>`).join("")}</w:tr>`;
const docx = (body) => Buffer.from(zipSync({ "[Content_Types].xml": strToU8(contentTypes), "_rels/.rels": strToU8(rootRels), "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`) }));
const file = (buffer, originalname, mimetype) => ({ buffer, originalname, mimetype, size: buffer.length });
const degraded = (sourceFile, sourceType, parserOptions) => runTemplateExtraction(sourceFile, { sourceType, env: {}, parserOptions });
const labels = (result) => result.fields.map((field) => field.label);
const assertClean = (result) => { assert.equal(result.diagnostics.qualityGate, true); assert.ok(result.fields.length > 0); assert.equal(result.fields.some((field) => isProvenanceOnlyLabel(field.label) || /block-|chunk-|header\d+\.xml|w:p|\/root\//i.test(field.label)), false); };

test("simple and complex-table DOCX files use normalized candidate extraction", async () => {
  const simpleBytes = docx(`${p("VESSEL PARTICULARS", true)}${p("Vessel Name: __________")}${p("Inspection Date: __________")}${p("Remarks: __________")}`);
  const simple = await degraded(file(simpleBytes, "simple.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "docx");
  assertClean(simple); assert.ok(labels(simple).includes("Vessel Name")); assert.ok(labels(simple).includes("Inspection Date")); assert.equal(simple.fields.find((field) => field.label === "Remarks").fieldType, "textarea");
  const complexBytes = docx(`${p("TANK READINGS", true)}<w:tbl>${row("Tank Pressure", "________")}${row("Tank Volume", "________")}${row("Tank Temperature", "________")}${row("Transfer Complete? YES / NO", "")}</w:tbl>${p("Master's Signature: ______")}`);
  const complex = await degraded(file(complexBytes, "complex.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "docx");
  assertClean(complex); assert.ok(labels(complex).some((label) => /Tank Pressure/i.test(label))); assert.ok(complex.fields.some((field) => field.fieldType === "yes_no")); assert.ok(complex.fields.some((field) => field.fieldType === "signature"));
});

test("text and scanned PDFs enter the same normalized pipeline", async () => {
  const pdf = await PDFDocument.create(); const page = pdf.addPage(); const font = await pdf.embedFont(StandardFonts.Helvetica); page.drawText("BUNKERING CHECKLIST", { x: 40, y: 760, font }); page.drawText("Inspection Date: __________", { x: 40, y: 720, font }); page.drawText("Transfer Complete? YES / NO", { x: 40, y: 690, font });
  const textResult = await degraded(file(Buffer.from(await pdf.save()), "text.pdf", "application/pdf"), "pdf");
  assertClean(textResult); assert.equal(textResult.extractionMethod, "text"); assert.ok(labels(textResult).includes("Inspection Date"));
  const scanned = await PDFDocument.create(); scanned.addPage();
  const scannedResult = await degraded(file(Buffer.from(await scanned.save()), "scanned.pdf", "application/pdf"), "pdf", { ocr: async () => ["SCANNED INSPECTION", "Vessel Name: ______", "Inspection Date: ______", "Master's Signature: ______"] });
  assertClean(scannedResult); assert.equal(scannedResult.extractionMethod, "ocr"); assert.ok(labels(scannedResult).includes("Vessel Name"));
});

test("simple and merged-cell XLSX workbooks preserve semantic labels without coordinates", async () => {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet("Hourly Log"); sheet.mergeCells("A1:C1"); sheet.getCell("A1").value = "VESSEL PARTICULARS"; sheet.getCell("A2").value = "Vessel Name"; sheet.getCell("B2").border = { bottom: { style: "thin" } }; sheet.getCell("A3").value = "Inspection Date"; sheet.getCell("B3").border = { bottom: { style: "thin" } }; sheet.getCell("A4").value = "Tank Pressure"; sheet.getCell("B4").border = { bottom: { style: "thin" } }; sheet.getCell("A5").value = "Transfer Complete? YES / NO";
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer()); const parsed = await parseDocumentToJson(file(buffer, "merged.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), { sourceType: "xlsx" });
  assert.equal(parsed.parser.package, "exceljs"); assert.ok(parsed.rows.length > 0); assert.ok(parsed.parts[0].mergeRanges.length > 0);
  const result = await degraded(file(buffer, "merged.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "xlsx"); assertClean(result); assert.ok(labels(result).includes("Tank Pressure")); assert.equal(result.fields.some((field) => /^[A-Z]+\d+$/.test(field.label)), false);
});

test("XML hierarchy produces semantic camelCase labels without paths", async () => {
  const xml = Buffer.from(`<?xml version="1.0"?><root><vessel><vesselName/><imoNumber/><inspectionDate/><remarks/><masterSignature/></vessel></root>`);
  const parsed = await parseDocumentToJson(file(xml, "form.xml", "application/xml"), { sourceType: "xml" }); assert.equal(parsed.parser.package, "fast-xml-parser");
  const result = await degraded(file(xml, "form.xml", "application/xml"), "xml"); assertClean(result); assert.ok(labels(result).includes("IMO Number")); assert.ok(labels(result).includes("Inspection Date")); assert.equal(result.fields.some((field) => field.label.startsWith("/")), false);
});

test("MeOH_Bunkering_Hourly_Checklist1.docx acceptance fixture yields clean maritime fields", async () => {
  const tankFields = ["Tank Pressure", "Tank Volume", "Tank LV (Level)", "Tank Temp"]; const operationalFields = ["Manifold Press / Temp (Liq)", "Manifold Press / Temp (Vap)", "Loaded Q'ty", "Tk Filling v/v Opening", "Wind / Sea", "Trim / List", "Mooring / Fender Condition", "Deck Leakage", "Gas Check", "Other Remarks", "Checked By (Sign)"];
  const sections = [1, 2, 3].map((number) => `${p(`NO.${number} MEOH TK`, true)}<w:tbl>${tankFields.map((label) => row(label, "________")).join("")}</w:tbl>`).join(""); const operational = `${p("OTHER OPERATIONAL PARAMETERS", true)}<w:tbl>${operationalFields.map((label) => row(label, "________")).join("")}</w:tbl>`;
  const bytes = docx(`${p("MEOH BUNKERING HOURLY CHECKLIST", true)}${p("Vessel Name: ______")}${p("IMO Number: ______")}${p("Inspection Date: ______")}${sections}${operational}`);
  const result = await degraded(file(bytes, "MeOH_Bunkering_Hourly_Checklist1.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "docx"); assertClean(result);
  assert.ok(result.fields.length >= 25); assert.ok(labels(result).includes("Vessel Name")); assert.ok(labels(result).includes("IMO Number")); assert.ok(result.fields.some((field) => field.fieldType === "signature")); assert.ok(result.fields.some((field) => field.label === "Other Remarks" && field.fieldType === "textarea"));
  console.info("MEOH_ACCEPTANCE", JSON.stringify({ parse: true, candidates: result.diagnostics.candidateCount, fields: result.fields.length, sections: result.sections.length, badProvenanceLabels: result.fields.filter((field) => isProvenanceOnlyLabel(field.label)).length, durationMs: result.diagnostics.durationMs, sample: result.fields.slice(0, 8).map(({ label, fieldType, section }) => ({ label, fieldType, section })) }));
});
