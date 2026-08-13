import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const PAGE = [595.28, 841.89];
const LEFT = 46; const RIGHT = 549; const WIDTH = RIGHT - LEFT; const BOTTOM = 58;
const NAVY = rgb(0.03, 0.11, 0.23); const TEAL = rgb(0.06, 0.56, 0.51); const SLATE = rgb(0.35, 0.42, 0.51);
const LINE = rgb(0.84, 0.88, 0.91); const TINT = rgb(0.95, 0.98, 0.98); const WHITE = rgb(1, 1, 1);
const text = (value) => String(value ?? "").normalize("NFKD").replace(/[–—−]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[^\x20-\x7E\n]/g, "").replace(/[\u0000-\u0009\u000B-\u001F]/g, " ").trim();
const isSignature = (field) => field.type === "signature" || /signature/i.test(field.label || "");
const isChecklist = (field) => field.type === "yes_no" || field.type === "checkbox" || field.type === "select" && (field.options || []).some((option) => /^(?:yes|no|not applicable|n\/?a)$/i.test(option));
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

function fitLine(font, value, size, maxWidth) {
  const source = text(value); if (font.widthOfTextAtSize(source, size) <= maxWidth) return source;
  let clipped = source; while (clipped.length > 1 && font.widthOfTextAtSize(`${clipped}...`, size) > maxWidth) clipped = clipped.slice(0, -1);
  return `${clipped.trimEnd()}...`;
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
    if (field.type === "section_heading" || field.type === "photo") return;
    if (isChecklist(field)) { flush(); const question = linesFor(font, field.label, 9, 303); rows.push({ type: "checklist", field, question, height: Math.max(34, question.length * 11 + 14) }); return; }
    if (isSignature(field)) { flush(); rows.push({ type: "signature", field, height: 100 }); return; }
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
  const drawRunningHeader = () => { drawAnchor(page, LEFT, 788); page.drawText("NexaPort", { x: LEFT + 23, y: 795, font: bold, size: 13, color: NAVY }); page.drawText(fitLine(bold, title, 9, 292), { x: 257, y: 795, font: bold, size: 9, color: SLATE }); page.drawLine({ start: { x: LEFT, y: 780 }, end: { x: RIGHT, y: 780 }, thickness: 1, color: TEAL }); y = 760; };
  const newPage = (first = false) => { page = pdf.addPage(PAGE); if (first) drawFullHeader(); else drawRunningHeader(); };
  const drawSection = (name, continued = false) => { currentSection = name; checklistNumber = continued ? checklistNumber : 0; page.drawRectangle({ x: LEFT, y: y - 27, width: WIDTH, height: 27, color: TINT }); page.drawRectangle({ x: LEFT, y: y - 27, width: 3, height: 27, color: TEAL }); page.drawText(`${text(name)}${continued ? " (continued)" : ""}`, { x: LEFT + 12, y: y - 18, font: bold, size: 12, color: NAVY }); y -= 37; };
  const ensure = (height, repeatSection = true) => { if (y - height >= BOTTOM) return false; newPage(false); if (repeatSection && currentSection) drawSection(currentSection, true); return true; };
  const drawPair = (row) => { const cellWidth = (WIDTH - 18) / 2; row.cells.forEach(({ field }, index) => { const x = LEFT + index * (cellWidth + 18); page.drawText(text(isIdentity(field) ? "Inspector" : field.label).toUpperCase(), { x, y: y - 10, font: bold, size: 7.7, color: SLATE }); linesFor(font, fieldValue(field, values), 10.5, cellWidth).forEach((line, lineIndex) => page.drawText(line, { x, y: y - 27 - lineIndex * 13, font, size: 10.5, color: NAVY })); }); page.drawLine({ start: { x: LEFT, y: y - row.height + 5 }, end: { x: RIGHT, y: y - row.height + 5 }, thickness: .5, color: LINE }); y -= row.height; };
  const checklistColumns = [28, 315, 28, 28, 28, 76];
  const drawChecklistGrid = (top, height, fill = null) => { let x = LEFT; if (fill) page.drawRectangle({ x: LEFT, y: top - height, width: WIDTH, height, color: fill }); page.drawRectangle({ x: LEFT, y: top - height, width: WIDTH, height, borderColor: LINE, borderWidth: .7 }); for (const width of checklistColumns.slice(0, -1)) { x += width; page.drawLine({ start: { x, y: top }, end: { x, y: top - height }, thickness: .55, color: LINE }); } };
  const drawChecklistHeader = () => { const height = 24; const labels = ["No.", "Item", "Yes", "No", "N/A", "Remarks"]; drawChecklistGrid(y, height, TINT); let x = LEFT; labels.forEach((label, index) => { const width = checklistColumns[index]; const labelWidth = bold.widthOfTextAtSize(label, 7.4); page.drawText(label.toUpperCase(), { x: index === 1 || index === 5 ? x + 7 : x + (width - labelWidth) / 2, y: y - 16, font: bold, size: 7.4, color: SLATE }); x += width; }); y -= height; };
  const drawChecklist = (row) => { checklistNumber += 1; const raw = values[row.field.fieldKey] ?? row.field.defaultValue; const answerValue = typeof raw === "object" && raw ? raw.answer ?? raw.value : raw; const remarks = typeof raw === "object" && raw ? raw.remarks : ""; const answer = text(answerValue).toLowerCase(); drawChecklistGrid(y, row.height); let x = LEFT; const centered = (value, column, size = 8.3) => { const width = checklistColumns[column]; if (value) page.drawText(value, { x: x + (width - font.widthOfTextAtSize(value, size)) / 2, y: y - 20, font: value === "X" ? bold : font, size, color: NAVY }); x += width; }; centered(String(checklistNumber), 0); row.question.forEach((line, index) => page.drawText(line, { x: x + 7, y: y - 16 - index * 11, font, size: 9, color: NAVY })); x += checklistColumns[1]; centered(answer === "yes" || answer === "true" || answer === "agreed" ? "X" : "", 2); centered(answer === "no" || answer === "false" ? "X" : "", 3); centered(/not applicable|n\/?a/.test(answer) ? "X" : "", 4); if (remarks) linesFor(font, remarks, 7.8, checklistColumns[5] - 12).slice(0, 3).forEach((line, index) => page.drawText(line, { x: x + 6, y: y - 14 - index * 9, font, size: 7.8, color: NAVY })); y -= row.height; };
  const drawSignatureField = (row) => { page.drawRectangle({ x: LEFT, y: y - row.height + 7, width: WIDTH, height: row.height - 7, borderColor: LINE, borderWidth: .7 }); page.drawText(text(row.field.label).toUpperCase(), { x: LEFT + 10, y: y - 17, font: bold, size: 7.7, color: SLATE }); const value = fieldValue(row.field, values); if (value !== "Not provided") page.drawText(value, { x: LEFT + 10, y: y - 39, font, size: 10, color: NAVY }); page.drawLine({ start: { x: LEFT + 10, y: y - 78 }, end: { x: RIGHT - 10, y: y - 78 }, thickness: .6, color: SLATE }); page.drawText("Signature", { x: LEFT + 10, y: y - 90, font, size: 7.5, color: SLATE }); y -= row.height; };
  const drawLong = (row) => { page.drawText(text(row.field.label).toUpperCase(), { x: LEFT, y: y - 10, font: bold, size: 7.7, color: SLATE }); row.valueLines.forEach((line, index) => page.drawText(line, { x: LEFT, y: y - 28 - index * 14, font, size: 10.5, color: NAVY })); page.drawLine({ start: { x: LEFT, y: y - row.height + 4 }, end: { x: RIGHT, y: y - row.height + 4 }, thickness: .5, color: LINE }); y -= row.height; };

  newPage(true);
  const groups = fields.reduce((all, field) => { const name = field.section || "General"; (all[name] ||= []).push(field); return all; }, {});
  for (const [section, sectionFields] of Object.entries(groups)) {
    const rows = makeRows(sectionFields, values, font, bold); if (!rows.length) continue;
    const firstRows = rows.slice(0, Math.min(2, rows.length)); const firstBlock = 37 + firstRows.reduce((sum, row) => sum + row.height, 0) + (firstRows[0]?.type === "checklist" ? 24 : 0);
    if (y - firstBlock < BOTTOM) newPage(false);
    drawSection(section);
    let inChecklist = false;
    for (const row of rows) {
      if (row.type === "checklist") {
        if (!inChecklist) { ensure(24 + row.height); drawChecklistHeader(); inChecklist = true; }
        else if (ensure(row.height)) drawChecklistHeader();
        drawChecklist(row); continue;
      }
      inChecklist = false; ensure(row.height);
      if (row.type === "pair") drawPair(row); else if (row.type === "signature") drawSignatureField(row); else drawLong(row);
    }
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
