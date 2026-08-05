import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const NAVY = rgb(0.04, 0.12, 0.25);
const TEAL = rgb(0.08, 0.72, 0.65);
const MUTED = rgb(0.38, 0.45, 0.55);
const printable = (value) => value === true ? "Yes" : value === false ? "No" : String(value ?? "").replace(/[\u0000-\u001f]/g, " ");
const wrap = (text, max = 82) => {
  const words = printable(text).split(/\s+/); const lines = []; let line = "";
  for (const word of words) { const next = `${line} ${word}`.trim(); if (next.length > max && line) { lines.push(line); line = word; } else line = next; }
  if (line) lines.push(line); return lines.length ? lines : [""];
};

function drawAnchor(page, x, y) {
  page.drawCircle({ x: x + 7, y: y + 13, size: 3, borderWidth: 1.4, borderColor: TEAL });
  page.drawLine({ start: { x: x + 7, y: y + 10 }, end: { x: x + 7, y }, thickness: 1.4, color: TEAL });
  page.drawLine({ start: { x, y: y + 5 }, end: { x: x + 14, y: y + 5 }, thickness: 1.4, color: TEAL });
  page.drawLine({ start: { x, y: y + 5 }, end: { x: x + 3, y: y + 1 }, thickness: 1.4, color: TEAL });
  page.drawLine({ start: { x: x + 14, y: y + 5 }, end: { x: x + 11, y: y + 1 }, thickness: 1.4, color: TEAL });
}

async function addEvidencePages(pdf, photos, font, bold) {
  for (const photo of photos) {
    let image;
    try { image = photo.mimeType === "image/png" ? await pdf.embedPng(photo.bytes) : await pdf.embedJpg(photo.bytes); } catch { throw new Error(`Unable to embed ${photo.label || "report image"}.`); }
    const page = pdf.addPage([595.28, 841.89]);
    page.drawText(photo.label || "Photo evidence", { x: 48, y: 785, font: bold, size: 16, color: NAVY });
    const scaled = image.scaleToFit(499, 620);
    page.drawImage(image, { x: 48 + (499 - scaled.width) / 2, y: 135 + (620 - scaled.height) / 2, width: scaled.width, height: scaled.height });
    if (photo.caption) page.drawText(printable(photo.caption).slice(0, 110), { x: 48, y: 105, font, size: 10, color: MUTED });
  }
}

function finishPages(pdf, font) {
  const pages = pdf.getPages();
  pages.forEach((page, index) => {
    page.drawLine({ start: { x: 42, y: 34 }, end: { x: 553, y: 34 }, thickness: 0.5, color: rgb(.85, .88, .91) });
    page.drawText("Powered by Fathom Tech", { x: 42, y: 19, font, size: 8, color: MUTED });
    page.drawText(`${index + 1} / ${pages.length}`, { x: 520, y: 19, font, size: 8, color: MUTED });
  });
}

export async function generateReportPdf({ title, fields, values, photos = [], consultant, serviceRequest }) {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica); const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    let page; let y;
    const newPage = () => { page = pdf.addPage([595.28, 841.89]); y = 785; drawAnchor(page, 43, y - 1); page.drawText("NexaPort", { x: 66, y, font: bold, size: 20, color: NAVY }); page.drawLine({ start: { x: 42, y: y - 10 }, end: { x: 553, y: y - 10 }, thickness: 2, color: TEAL }); y -= 44; };
    const ensure = (height) => { if (y - height < 58) newPage(); };
    newPage();
    page.drawText(printable(title).slice(0, 70), { x: 42, y, font: bold, size: 18, color: NAVY }); y -= 25;
    page.drawText(`Consultant: ${printable(consultant?.full_name || consultant?.email || "NexaPort Consultant")}`, { x: 42, y, font, size: 10, color: MUTED }); y -= 15;
    if (serviceRequest) { page.drawText(`Service request: ${printable(serviceRequest.title || serviceRequest.id)}`, { x: 42, y, font, size: 10, color: MUTED }); y -= 15; }
    page.drawText(`Generated: ${new Date().toISOString()}`, { x: 42, y, font, size: 9, color: MUTED }); y -= 30;
    let section = null;
    for (const field of fields) {
      if (["photo", "signature"].includes(field.type)) continue;
      if (field.section !== section || field.type === "section_heading") { section = field.section; ensure(30); page.drawText(printable(field.type === "section_heading" ? field.label : section), { x: 42, y, font: bold, size: 13, color: NAVY }); y -= 20; if (field.type === "section_heading") continue; }
      const lines = wrap(values[field.fieldKey] ?? field.defaultValue);
      ensure(27 + lines.length * 13); page.drawText(printable(field.label).slice(0, 90), { x: 42, y, font: bold, size: 9, color: MUTED }); y -= 14;
      for (const line of lines) { page.drawText(line.slice(0, 105), { x: 42, y, font, size: 11, color: NAVY }); y -= 13; }
      y -= 10;
    }
  const evidenceFont = await pdf.embedFont(StandardFonts.Helvetica); const evidenceBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  await addEvidencePages(pdf, photos, evidenceFont, evidenceBold);
  finishPages(pdf, evidenceFont);
  return Buffer.from(await pdf.save());
}
