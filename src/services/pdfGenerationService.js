import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const PAGE = [595.28, 841.89];
const LEFT = 46; const RIGHT = 549; const WIDTH = RIGHT - LEFT; const BOTTOM = 58;
const NAVY = rgb(0.03, 0.11, 0.23); const TEAL = rgb(0.06, 0.56, 0.51); const SLATE = rgb(0.35, 0.42, 0.51);
const LINE = rgb(0.84, 0.88, 0.91); const TINT = rgb(0.95, 0.98, 0.98); const WHITE = rgb(1, 1, 1);
const text = (value) => String(value ?? "").normalize("NFKD").replace(/[–—−]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[^\x20-\x7E\n]/g, "").replace(/[\u0000-\u0009\u000B-\u001F]/g, " ").trim();
const isSignature = (field) => field.type === "signature" || /signature/i.test(field.label || "");
const isIdentity = (field) => field.type === "system_identity" || /^(inspector|surveyor|consultant)( name)?$/i.test(field.label || "");
const humanDate = (value) => {
  if (!value) return "Not provided";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(`${value}T00:00:00`) : new Date(value);
  return Number.isNaN(date.getTime()) ? text(value) : date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
};
const humanDateTime = (value) => {
  const date = value ? new Date(value) : new Date();
  return date.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

function linesFor(font, value, size, maxWidth) {
  const words = text(value || "Not provided").split(/\s+/); const lines = []; let line = "";
  for (const word of words) {
    const candidate = `${line} ${word}`.trim();
    if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  return lines.length ? lines : ["Not provided"];
}

function drawAnchor(page, x, y) {
  page.drawCircle({ x: x + 7, y: y + 13, size: 3, borderWidth: 1.3, borderColor: TEAL });
  page.drawLine({ start: { x: x + 7, y: y + 10 }, end: { x: x + 7, y }, thickness: 1.3, color: TEAL });
  page.drawLine({ start: { x, y: y + 5 }, end: { x: x + 14, y: y + 5 }, thickness: 1.3, color: TEAL });
  page.drawLine({ start: { x, y: y + 5 }, end: { x: x + 3, y: y + 1 }, thickness: 1.3, color: TEAL });
  page.drawLine({ start: { x: x + 14, y: y + 5 }, end: { x: x + 11, y: y + 1 }, thickness: 1.3, color: TEAL });
}

function fieldValue(field, values) {
  if (isIdentity(field)) return "NexaPort Inspector";
  const value = values[field.fieldKey] ?? field.defaultValue;
  if (field.type === "date" && value) return humanDate(value);
  if (value === true) return "Yes"; if (value === false) return "No";
  return text(value) || "Not provided";
}

function makeRows(fields, values, font, bold) {
  const rows = []; let pair = [];
  const flush = () => { if (pair.length) { const cells = pair; const heights = cells.map(({ field }) => linesFor(font, fieldValue(field, values), 10.5, 224).length * 13); rows.push({ type: "pair", cells, height: Math.max(...heights) + 31 }); pair = []; } };
  fields.forEach((field) => {
    if (field.type === "section_heading" || field.type === "photo" || isSignature(field)) return;
    if (field.type === "yes_no") { flush(); const question = linesFor(font, field.label, 10, 348); rows.push({ type: "yesno", field, question, height: Math.max(38, question.length * 12 + 17) }); return; }
    if (field.type === "textarea" || fieldValue(field, values).length > 90) { flush(); const valueLines = linesFor(font, fieldValue(field, values), 10.5, WIDTH - 20); rows.push({ type: "long", field, valueLines, height: 29 + valueLines.length * 14 }); return; }
    pair.push({ field, bold }); if (pair.length === 2) flush();
  }); flush(); return rows;
}

export async function generateReportPdf({ title, fields, values, photos = [], serviceRequest, status = "completed", versionNumber = 1, generatedAt = new Date() }) {
  const photoCounts = new Map();
  for (const item of photos) {
    if (item.fieldKey) {
      photoCounts.set(item.fieldKey, (photoCounts.get(item.fieldKey) || 0) + 1);
    }
  }
  for (const field of fields) {
    if (field.type === "photo") {
      const count = photoCounts.get(field.fieldKey) || 0;
      const max = Number(field.maxPhotos) || 1;
      if (count > max) {
        throw Object.assign(new Error(`Maximum ${max} photo${max === 1 ? "" : "s"} allowed for ${field.label}.`), { status: 400 });
      }
      if (field.required && count === 0) {
        throw Object.assign(new Error(`Required photo field "${field.label}" requires at least one image.`), { status: 400 });
      }
    }
  }

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica); const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page; let y; let currentSection = ""; let checklistNumber = 0;

  const drawFullHeader = () => {
    drawAnchor(page, LEFT, 788); page.drawText("NexaPort", { x: LEFT + 23, y: 795, font: bold, size: 18, color: NAVY });
    page.drawText("INSPECTION REPORT", { x: 419, y: 800, font: bold, size: 9, color: TEAL });
    page.drawText(`${text(status).toUpperCase()}  |  VERSION ${versionNumber}`, { x: 405, y: 784, font, size: 8, color: SLATE });
    page.drawLine({ start: { x: LEFT, y: 772 }, end: { x: RIGHT, y: 772 }, thickness: 1.8, color: TEAL });
    const titleLines = linesFor(bold, title, 22, WIDTH); let titleY = 738;
    titleLines.slice(0, 2).forEach((line) => { page.drawText(line, { x: LEFT, y: titleY, font: bold, size: 22, color: NAVY }); titleY -= 26; });
    page.drawText(`Generated ${humanDateTime(generatedAt)}`, { x: LEFT, y: titleY - 2, font, size: 9, color: SLATE });
    page.drawText("Inspector: NexaPort Inspector", { x: 350, y: titleY - 2, font: bold, size: 9, color: NAVY });
    y = titleY - 32;
    const metadata = [["Inspector", "NexaPort Inspector"], ["Status", text(status)], ["Template", `Version ${versionNumber}`], ...(serviceRequest?.title ? [["Request", serviceRequest.title]] : []), ...(serviceRequest?.vessel_name ? [["Vessel", serviceRequest.vessel_name]] : []), ...(serviceRequest?.imo_number ? [["IMO", serviceRequest.imo_number]] : []), ...(serviceRequest?.port_name ? [["Port", serviceRequest.port_name]] : [])];
    const columns = 3; const cellWidth = WIDTH / columns; const rowHeight = 44; const rows = Math.ceil(metadata.length / columns); const top = y;
    page.drawRectangle({ x: LEFT, y: top - rows * rowHeight, width: WIDTH, height: rows * rowHeight, color: TINT, borderColor: LINE, borderWidth: .7 });
    metadata.forEach(([label, value], index) => { const col = index % columns; const row = Math.floor(index / columns); const x = LEFT + col * cellWidth + 10; const cellY = top - row * rowHeight - 13; page.drawText(text(label).toUpperCase(), { x, y: cellY, font: bold, size: 7.5, color: SLATE }); linesFor(font, value, 8.8, cellWidth - 20).slice(0, 2).forEach((line, lineIndex) => page.drawText(line, { x, y: cellY - 14 - lineIndex * 10, font, size: 8.8, color: NAVY })); });
    y = top - rows * rowHeight - 18;
  };
  const drawRunningHeader = () => { drawAnchor(page, LEFT, 788); page.drawText("NexaPort", { x: LEFT + 23, y: 795, font: bold, size: 13, color: NAVY }); page.drawText(text(title).slice(0, 52), { x: 252, y: 795, font: bold, size: 9, color: SLATE }); page.drawLine({ start: { x: LEFT, y: 780 }, end: { x: RIGHT, y: 780 }, thickness: 1, color: TEAL }); y = 760; };
  const newPage = (first = false) => { page = pdf.addPage(PAGE); if (first) drawFullHeader(); else drawRunningHeader(); };
  const drawSection = (name, continued = false) => { currentSection = name; checklistNumber = continued ? checklistNumber : 0; page.drawRectangle({ x: LEFT, y: y - 27, width: WIDTH, height: 27, color: TINT }); page.drawRectangle({ x: LEFT, y: y - 27, width: 3, height: 27, color: TEAL }); page.drawText(`${text(name)}${continued ? " (continued)" : ""}`, { x: LEFT + 12, y: y - 18, font: bold, size: 12, color: NAVY }); y -= 37; };
  const ensure = (height, repeatSection = true) => { if (y - height >= BOTTOM) return; newPage(false); if (repeatSection && currentSection) drawSection(currentSection, true); };
  const drawPair = (row) => { const cellWidth = (WIDTH - 18) / 2; row.cells.forEach(({ field }, index) => { const x = LEFT + index * (cellWidth + 18); page.drawText(text(isIdentity(field) ? "Inspector" : field.label).toUpperCase(), { x, y: y - 10, font: bold, size: 7.7, color: SLATE }); linesFor(font, fieldValue(field, values), 10.5, cellWidth).forEach((line, lineIndex) => page.drawText(line, { x, y: y - 27 - lineIndex * 13, font, size: 10.5, color: NAVY })); }); page.drawLine({ start: { x: LEFT, y: y - row.height + 5 }, end: { x: RIGHT, y: y - row.height + 5 }, thickness: .5, color: LINE }); y -= row.height; };
  const drawYesNo = (row) => { checklistNumber += 1; const answer = fieldValue(row.field, values).toLowerCase(); page.drawText(`${checklistNumber}.`, { x: LEFT, y: y - 14, font: bold, size: 9, color: SLATE }); row.question.forEach((line, index) => page.drawText(line, { x: LEFT + 23, y: y - 14 - index * 12, font, size: 10, color: NAVY })); const box = (x, label, selected) => { page.drawRectangle({ x, y: y - 23, width: 10, height: 10, borderColor: NAVY, borderWidth: .8, color: WHITE }); if (selected) { page.drawLine({ start: { x: x + 2, y: y - 18 }, end: { x: x + 5, y: y - 21 }, thickness: 1.2, color: NAVY }); page.drawLine({ start: { x: x + 5, y: y - 21 }, end: { x: x + 9, y: y - 14 }, thickness: 1.2, color: NAVY }); } page.drawText(label, { x: x + 15, y: y - 22, font: selected ? bold : font, size: 8.5, color: NAVY }); }; box(443, "Yes", answer === "yes"); box(497, "No", answer === "no"); page.drawLine({ start: { x: LEFT, y: y - row.height + 4 }, end: { x: RIGHT, y: y - row.height + 4 }, thickness: .5, color: LINE }); y -= row.height; };
  const drawLong = (row) => { page.drawText(text(row.field.label).toUpperCase(), { x: LEFT, y: y - 10, font: bold, size: 7.7, color: SLATE }); row.valueLines.forEach((line, index) => page.drawText(line, { x: LEFT, y: y - 28 - index * 14, font, size: 10.5, color: NAVY })); page.drawLine({ start: { x: LEFT, y: y - row.height + 4 }, end: { x: RIGHT, y: y - row.height + 4 }, thickness: .5, color: LINE }); y -= row.height; };

  newPage(true);
  const groups = fields.reduce((all, field) => { const name = field.section || "General"; (all[name] ||= []).push(field); return all; }, {});
  for (const [section, sectionFields] of Object.entries(groups)) {
    const rows = makeRows(sectionFields, values, font, bold); if (!rows.length) continue;
    const total = 37 + rows.reduce((sum, row) => sum + row.height, 0); const freshCapacity = 760 - BOTTOM;
    if ((total <= freshCapacity && y - total < BOTTOM) || y - (37 + rows.slice(0, 2).reduce((sum, row) => sum + row.height, 0)) < BOTTOM) newPage(false);
    drawSection(section);
    for (const row of rows) { ensure(row.height); if (row.type === "pair") drawPair(row); else if (row.type === "yesno") drawYesNo(row); else drawLong(row); }
  }

  const photoMedia = photos.filter((item) => item.type !== "signature");
  if (photoMedia.length) {
    currentSection = "Photo Evidence"; ensure(37, false); drawSection(currentSection);
    for (const item of photoMedia) {
      let image; try { image = item.mimeType === "image/png" ? await pdf.embedPng(item.bytes) : await pdf.embedJpg(item.bytes); } catch { throw new Error(`Unable to embed ${item.label || "report image"}.`); }
      const captionLines = item.caption ? linesFor(font, item.caption, 9, WIDTH - 20) : []; const blockHeight = 326 + captionLines.length * 12; ensure(blockHeight);
      page.drawRectangle({ x: LEFT, y: y - blockHeight + 7, width: WIDTH, height: blockHeight - 7, borderColor: LINE, borderWidth: .7 }); page.drawText(text(item.label || "Photo Evidence"), { x: LEFT + 10, y: y - 19, font: bold, size: 10.5, color: NAVY });
      const scaled = image.scaleToFit(WIDTH - 28, 250); page.drawImage(image, { x: LEFT + (WIDTH - scaled.width) / 2, y: y - 286 + (250 - scaled.height) / 2, width: scaled.width, height: scaled.height }); captionLines.forEach((line, index) => page.drawText(line, { x: LEFT + 10, y: y - 304 - index * 12, font, size: 9, color: SLATE })); y -= blockHeight;
    }
  }

  const signature = photos.find((item) => item.type === "signature");
  if (signature) {
    currentSection = "Summary & Sign-Off"; ensure(250, false); drawSection(currentSection);
    let image; try { image = signature.mimeType === "image/png" ? await pdf.embedPng(signature.bytes) : await pdf.embedJpg(signature.bytes); } catch { throw new Error("Unable to embed signature image."); }
    const blockHeight = 190; ensure(blockHeight); page.drawRectangle({ x: LEFT, y: y - blockHeight, width: WIDTH, height: blockHeight, borderColor: LINE, borderWidth: .7 }); page.drawText("INSPECTOR", { x: LEFT + 12, y: y - 18, font: bold, size: 7.7, color: SLATE }); page.drawText("NexaPort Inspector", { x: LEFT + 12, y: y - 35, font: bold, size: 11, color: NAVY }); page.drawText(`Signed ${humanDate(generatedAt)}`, { x: RIGHT - 120, y: y - 35, font, size: 8.5, color: SLATE }); const scaled = image.scaleToFit(WIDTH - 28, 105); page.drawImage(image, { x: LEFT + 14, y: y - 157, width: scaled.width, height: scaled.height }); y -= blockHeight;
  }

  const pages = pdf.getPages(); pages.forEach((pdfPage, index) => { pdfPage.drawLine({ start: { x: LEFT, y: 42 }, end: { x: RIGHT, y: 42 }, thickness: .6, color: LINE }); pdfPage.drawText("Powered by Fathom Tech", { x: LEFT, y: 25, font, size: 8, color: SLATE }); const center = "NexaPort Inspection Report"; pdfPage.drawText(center, { x: (PAGE[0] - font.widthOfTextAtSize(center, 8)) / 2, y: 25, font, size: 8, color: SLATE }); const pageNumber = `Page ${index + 1} of ${pages.length}`; pdfPage.drawText(pageNumber, { x: RIGHT - font.widthOfTextAtSize(pageNumber, 8), y: 25, font, size: 8, color: SLATE }); });
  pdf.setTitle(text(title)); pdf.setSubject("NexaPort Inspection Report"); pdf.setProducer("NexaPort");
  return Buffer.from(await pdf.save());
}
