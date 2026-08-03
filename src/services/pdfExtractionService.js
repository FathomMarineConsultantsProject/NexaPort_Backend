import { PDFDocument, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFTextField } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { normalizeFields } from "./templateFieldService.js";

const meaningful = (text) => text.replace(/\s+/g, " ").trim();
const fieldType = (field) => field instanceof PDFCheckBox ? "checkbox" : field instanceof PDFDropdown || field instanceof PDFOptionList ? "select" : field instanceof PDFRadioGroup ? "yes_no" : field instanceof PDFTextField && field.isMultiline() ? "textarea" : "text";

async function acroFormFields(bytes) {
  const document = await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: true });
  const pages = document.getPages();
  const fields = document.getForm().getFields();
  return { document, pages, fields: fields.map((field, index) => {
    const widget = field.acroField.getWidgets()[0];
    const rect = widget?.getRectangle();
    const pageIndex = widget ? pages.findIndex((page) => page.ref.toString() === widget.P()?.toString()) : -1;
    let defaultValue = "";
    try { defaultValue = field.getText?.() ?? field.getSelected?.()?.[0] ?? field.isChecked?.() ?? ""; } catch { defaultValue = ""; }
    return { label: field.getName(), type: fieldType(field), defaultValue, sourceFieldName: field.getName(), sourcePageNumber: pageIndex >= 0 ? pageIndex + 1 : null, sourceCoordinates: rect || null, sortOrder: index };
  }) };
}

const candidateLabels = (text) => {
  const common = /^(vessel|ship|imo|date|location|port|inspector|surveyor|condition|finding|observation|recommendation|result|status|remarks|description)\b/i;
  const values = [];
  for (const line of text.split(/\r?\n/).map(meaningful).filter(Boolean)) {
    let label = "";
    if (/^.{2,100}:$/.test(line)) label = line.slice(0, -1);
    else if (/^.{2,80}\s_{3,}$/.test(line)) label = line.replace(/\s_{3,}$/, "");
    else if (/^[☐☑□■]\s*.{2,100}$/.test(line)) label = line.replace(/^[☐☑□■]\s*/, "");
    else if (common.test(line) && line.length <= 80) label = line.replace(/:$/, "");
    label = meaningful(label);
    if (label && !values.some((value) => value.toLowerCase() === label.toLowerCase())) values.push(label);
  }
  return values.slice(0, 150);
};

export async function extractPdfFields(buffer) {
  const bytes = new Uint8Array(buffer);
  const acro = await acroFormFields(bytes);
  if (acro.pages.length > 25) return { mode: "manual", pageCount: acro.pages.length, fields: [], message: "Automatic extraction supports PDFs up to 25 pages. Add fields manually using the template builder." };
  if (acro.fields.length) return { mode: "acroform", pageCount: acro.pages.length, fields: normalizeFields(acro.fields, { keepKeys: false }) };
  const task = getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true });
  const pdf = await task.promise;
  const lines = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const content = await (await pdf.getPage(pageNumber)).getTextContent();
    lines.push(content.items.map((item) => item.str).join("\n"));
  }
  await task.destroy();
  const text = meaningful(lines.join(" "));
  if (text.length < 20) return { mode: "manual", pageCount: pdf.numPages, fields: [], message: "No fields could be detected automatically. Add fields manually using the template builder." };
  const labels = candidateLabels(lines.join("\n"));
  return { mode: "text", pageCount: pdf.numPages, fields: normalizeFields(labels.map((label, sortOrder) => ({ label, sortOrder })), { keepKeys: false }), message: labels.length ? "Candidate fields were inferred from document text. Review every field before saving." : "No fields could be detected automatically. Add fields manually using the template builder." };
}
