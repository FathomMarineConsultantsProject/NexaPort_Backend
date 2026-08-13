import assert from "node:assert/strict";
import test from "node:test";
import { zipSync, strToU8 } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { parseDocumentToJson } from "../src/services/documentJsonService.js";
import { normalizeAnalysisInput, requestOpenRouter, templateMappingOutputSchema } from "../src/services/openRouterTemplateService.js";

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Vessel Particulars</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Vessel Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>IMO Number</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>Inspection Date:</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`;

const docxFixture = () => Buffer.from(zipSync({
  "[Content_Types].xml": strToU8(contentTypes),
  "_rels/.rels": strToU8(rootRels),
  "word/document.xml": strToU8(documentXml),
}));

test("DOCX is converted to complete structured JSON with headings and tables", async () => {
  const result = await parseDocumentToJson({ buffer: docxFixture(), originalname: "fixture.docx", mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, { sourceType: "docx" });
  assert.equal(result.parser.package, "officeparser");
  assert.match(JSON.stringify(result.content), /Vessel Particulars/);
  assert.match(JSON.stringify(result.content), /table/);
  assert.match(result.blocks.map((block) => block.text).join(" "), /IMO Number/);
});

test("PDF is converted to page-aware structured JSON", async () => {
  const pdf = await PDFDocument.create(); const page = pdf.addPage(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Bunkering Checklist", { x: 50, y: 750, font }); page.drawText("Inspection Date:", { x: 50, y: 720, font });
  const buffer = Buffer.from(await pdf.save());
  const result = await parseDocumentToJson({ buffer, originalname: "fixture.pdf", mimetype: "application/pdf" }, { sourceType: "pdf" });
  assert.equal(result.fileType, "pdf");
  assert.match(JSON.stringify(result.content), /Bunkering Checklist/);
  assert.ok(result.blocks.length > 0);
});

test("whole document JSON is normalized for one AI request without block truncation", () => {
  const blocks = Array.from({ length: 220 }, (_, index) => ({ id: `block-${index}`, globalOrder: index, partOrder: index, type: "paragraph", text: `Inspection item ${index}`, metadata: {}, location: {} }));
  const normalized = normalizeAnalysisInput({ mode: "map", sourceType: "docx", documentTitle: "Fixture", document: { fileName: "fixture.docx", fileType: "docx", content: [{ type: "paragraph", text: "complete" }], blocks } });
  assert.equal(normalized.document.blocks.length, 220);
  assert.equal(normalized.document.content[0].text, "complete");
  assert.equal(templateMappingOutputSchema.strict, true);
});

for (const [status, code, reason] of [[402, "AI_PROVIDER_PAYMENT_REQUIRED", "payment_required"], [403, "AI_PROVIDER_ACCESS_DENIED", "access_denied"]]) {
  test(`OpenRouter ${status} preserves its safe provider category and response reason`, async () => {
    const input = normalizeAnalysisInput({ mode: "map", sourceType: "docx", documentTitle: "Fixture", document: { fileName: "fixture.docx", content: [], blocks: [{ id: "block-0", globalOrder: 0, partOrder: 0, type: "paragraph", text: "Inspection Date", metadata: {}, location: {} }] } });
    await assert.rejects(
      requestOpenRouter(input, { env: { OPENROUTER_API_KEY: "test", OPENROUTER_TEMPLATE_MODEL: "test/model" }, fetchImpl: async () => ({ ok: false, status, json: async () => ({ error: { message: status === 402 ? "Insufficient credits" : "Model access denied" } }) }) }),
      (error) => error.status === status && error.code === code && error.reason === reason && Boolean(error.safeProviderMessage),
    );
  });
}
