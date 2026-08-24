import { readFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";

const PAGE = [595.28, 841.89];
const MARGIN = 46;
const CONTENT_TOP = 734;
const CONTENT_BOTTOM = 62;
const NAVY = rgb(0.055, 0.14, 0.22);
const TEAL = rgb(0.02, 0.43, 0.42);
const INK = rgb(0.09, 0.13, 0.17);
const SLATE = rgb(0.34, 0.41, 0.47);
const LINE = rgb(0.78, 0.82, 0.84);
const PALE = rgb(0.95, 0.97, 0.97);
const YELLOW = rgb(0.99, 0.79, 0.02);

import { toIsoDate } from "./dailyReportService.js";

const clean = (value, fallback = "Not provided") => String(value ?? "").trim() || fallback;
const asDate = (value) => {
  const iso = toIsoDate(value);
  if (!iso) return "Not provided";
  const [y, m, d] = iso.split("-").map(Number);
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  return `${String(d).padStart(2, "0")} ${months[m - 1]} ${y}`;
};
const wrap = (font, text, size, width) => {
  const words = clean(text).replace(/\s+/g, " ").split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || font.widthOfTextAtSize(candidate, size) <= width) current = candidate;
    else {
      lines.push(current);
      current = word;
      while (font.widthOfTextAtSize(current, size) > width && current.length > 1) {
        let cut = current.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(current.slice(0, cut), size) > width) cut -= 1;
        lines.push(current.slice(0, cut));
        current = current.slice(cut);
      }
    }
  }
  if (current) lines.push(current);
  return lines;
};

const drawTextLines = (page, font, lines, { x, y, size = 9, color = INK, lineHeight = 12 }) => {
  lines.forEach((line, index) => page.drawText(line, { x, y: y - index * lineHeight, font, size, color }));
  return y - lines.length * lineHeight;
};

const MAX_REPORT_IMAGE_WIDTH = 1600;
const MAX_REPORT_IMAGE_HEIGHT = 1200;
const MAX_INPUT_PIXELS = 40_000_000;

export const prepareDailyReportImage = async (bytes) => {
  const source = sharp(bytes, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true }).rotate();
  const metadata = await source.metadata();
  const resized = source.resize({
    width: MAX_REPORT_IMAGE_WIDTH,
    height: MAX_REPORT_IMAGE_HEIGHT,
    fit: "inside",
    withoutEnlargement: true,
  });
  if (metadata.hasAlpha) return { bytes: await resized.png({ compressionLevel: 9 }).toBuffer(), format: "png" };
  return { bytes: await resized.jpeg({ quality: 84, mozjpeg: true }).toBuffer(), format: "jpeg" };
};

export async function generateDailyReportPdf({ report, context, photos = [], generatedAt = new Date() }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Daily Inspection Report - Day ${report.dayNumber} - ${clean(context.vessel?.name)}`);
  pdf.setAuthor("NexaPort Inspection Manager");
  pdf.setSubject("Daily inspection execution record");
  pdf.setCreator("NexaPort Inspection Manager");
  pdf.setCreationDate(generatedAt);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const masthead = await pdf.embedPng(await readFile(new URL("../assets/nexport-masthead.png", import.meta.url)));
  const embeddedPhotos = [];
  for (const photo of photos) {
    try {
      const prepared = photo.preparedImage || await prepareDailyReportImage(photo.bytes);
      const image = prepared.format === "png" ? await pdf.embedPng(prepared.bytes) : await pdf.embedJpg(prepared.bytes);
      embeddedPhotos.push({ ...photo, image });
    }
    catch { embeddedPhotos.push({ ...photo, image: null }); }
  }

  const pages = [];
  let page;
  let y;
  const addPage = () => {
    page = pdf.addPage(PAGE);
    pages.push(page);
    const logo = masthead.scaleToFit(184, 58);
    page.drawImage(masthead, { x: MARGIN, y: PAGE[1] - 38 - logo.height, width: logo.width, height: logo.height });
    page.drawText("DAILY INSPECTION REPORT", { x: 332, y: 795, font: bold, size: 12, color: NAVY });
    page.drawText(`DAY ${report.dayNumber}`, { x: 332, y: 775, font: bold, size: 18, color: TEAL });
    page.drawText(`REPORT DATE  ${asDate(report.reportDate).toUpperCase()}`, { x: 332, y: 758, font: regular, size: 7.5, color: SLATE });
    page.drawLine({ start: { x: MARGIN, y: 744 }, end: { x: PAGE[0] - MARGIN, y: 744 }, thickness: 1.2, color: NAVY });
    page.drawLine({ start: { x: MARGIN, y: 741 }, end: { x: PAGE[0] - MARGIN, y: 741 }, thickness: 2.5, color: YELLOW });
    y = CONTENT_TOP;
  };
  const ensure = (height) => { if (y - height < CONTENT_BOTTOM) addPage(); };
  const section = (title) => {
    ensure(31);
    page.drawRectangle({ x: MARGIN, y: y - 23, width: PAGE[0] - MARGIN * 2, height: 23, color: NAVY });
    page.drawText(title.toUpperCase(), { x: MARGIN + 10, y: y - 15, font: bold, size: 8.5, color: rgb(1, 1, 1) });
    y -= 31;
  };
  const keyValue = (label, value, x, width, top) => {
    page.drawText(label.toUpperCase(), { x, y: top, font: bold, size: 6.8, color: SLATE });
    const lines = wrap(regular, value, 9.2, width);
    drawTextLines(page, regular, lines, { x, y: top - 13, size: 9.2, lineHeight: 11.5, color: INK });
    return 19 + lines.length * 11.5;
  };

  addPage();
  section("Vessel and attendance particulars");
  const vesselName = clean(context.vessel?.name).toUpperCase();
  page.drawText(vesselName, { x: MARGIN + 10, y: y - 12, font: bold, size: 16, color: NAVY });
  page.drawText(`IMO ${clean(context.vessel?.imoNumber)}`, { x: PAGE[0] - MARGIN - 116, y: y - 10, font: bold, size: 9, color: TEAL });
  y -= 38;
  const colGap = 18;
  const colWidth = (PAGE[0] - MARGIN * 2 - colGap) / 2;
  const leftHeight = Math.max(
    keyValue("Inspection reference", context.request?.reference, MARGIN + 10, colWidth - 10, y),
    keyValue("Report date / sequence", `${asDate(report.reportDate)} / Day ${report.dayNumber}`, MARGIN + colWidth + colGap, colWidth - 10, y),
  );
  y -= leftHeight;
  const row2 = Math.max(
    keyValue("Vessel location", report.data?.locationDetail || [context.request?.port?.name, context.request?.port?.country].filter(Boolean).join(", "), MARGIN + 10, colWidth - 10, y),
    keyValue("Inspector", context.surveyor?.name, MARGIN + colWidth + colGap, colWidth - 10, y),
  );
  y -= row2;
  const row3 = Math.max(
    keyValue("Scope of inspection", report.data?.inspectionScope || context.request?.scope, MARGIN + 10, colWidth - 10, y),
    keyValue("Boarded vessel", [report.data?.boardingTime && `${report.data.boardingTime} hrs LT`, report.data?.boardingDate && `on ${asDate(report.data.boardingDate)}`, report.data?.boardingLocation && `at ${report.data.boardingLocation}`].filter(Boolean).join(" "), MARGIN + colWidth + colGap, colWidth - 10, y),
  );
  y -= row3 + 4;

  section(`Checks, tests and inspection carried out on ${asDate(report.reportDate)}`);
  const tableX = MARGIN;
  const tableWidth = PAGE[0] - MARGIN * 2;
  const numberWidth = 38;
  const drawActivityHeader = () => {
    page.drawRectangle({ x: tableX, y: y - 22, width: tableWidth, height: 22, color: PALE, borderColor: LINE, borderWidth: 0.7 });
    page.drawText("NO.", { x: tableX + 10, y: y - 14, font: bold, size: 7.2, color: SLATE });
    page.drawText("ACTIVITY / INSPECTION RECORD", { x: tableX + numberWidth + 10, y: y - 14, font: bold, size: 7.2, color: SLATE });
    y -= 22;
  };
  drawActivityHeader();
  const activities = Array.isArray(report.data?.activities) && report.data.activities.length ? report.data.activities : [{ description: "Not provided" }];
  for (let index = 0; index < activities.length; index += 1) {
    let lines = wrap(regular, activities[index]?.description, 9, tableWidth - numberWidth - 20);
    let continuation = false;
    while (lines.length) {
      const maxLines = Math.max(1, Math.floor((y - CONTENT_BOTTOM - 14) / 11.5));
      if (maxLines < 1 || y - 25 < CONTENT_BOTTOM) { addPage(); section(`Checks, tests and inspection - Day ${report.dayNumber} (continued)`); drawActivityHeader(); }
      const availableLines = Math.max(1, Math.floor((y - CONTENT_BOTTOM - 14) / 11.5));
      const chunk = lines.splice(0, availableLines);
      const height = Math.max(27, chunk.length * 11.5 + 12);
      page.drawRectangle({ x: tableX, y: y - height, width: tableWidth, height, borderColor: LINE, borderWidth: 0.55 });
      page.drawLine({ start: { x: tableX + numberWidth, y }, end: { x: tableX + numberWidth, y: y - height }, thickness: 0.55, color: LINE });
      page.drawText(continuation ? "" : String(index + 1).padStart(2, "0"), { x: tableX + 10, y: y - 17, font: bold, size: 8, color: TEAL });
      drawTextLines(page, regular, chunk, { x: tableX + numberWidth + 10, y: y - 16, size: 9, lineHeight: 11.5, color: INK });
      y -= height;
      continuation = true;
      if (lines.length) { addPage(); section(`Checks, tests and inspection - Day ${report.dayNumber} (continued)`); drawActivityHeader(); }
    }
  }
  y -= 10;

  const remarkLines = wrap(regular, report.data?.closingStatement, 9.2, tableWidth - 20);
  const remarkHeight = Math.max(42, remarkLines.length * 12 + 20);
  ensure(31 + remarkHeight);
  section("Inspector's remarks");
  page.drawRectangle({ x: MARGIN, y: y - remarkHeight, width: tableWidth, height: remarkHeight, color: rgb(0.985, 0.988, 0.99), borderColor: LINE, borderWidth: 0.7 });
  drawTextLines(page, regular, remarkLines, { x: MARGIN + 10, y: y - 17, size: 9.2, lineHeight: 12, color: INK });
  y -= remarkHeight + 10;

  if (embeddedPhotos.length) {
    ensure(31 + 200);
    section("Photographic record");
    const gap = 12;
    const cardWidth = (tableWidth - gap) / 2;
    for (let index = 0; index < embeddedPhotos.length; index += 2) {
      const pair = embeddedPhotos.slice(index, index + 2);
      const preparedPair = pair.map((photo, offset) => {
        const caption = [photo.inspectionArea, photo.caption].filter(Boolean).join(" - ") || "Not provided";
        return { photo, offset, captionLines: wrap(regular, caption, 7.8, cardWidth - 16) };
      });
      const captionLineCount = Math.max(...preparedPair.map((item) => item.captionLines.length), 1);
      const cardHeight = 180 + Math.max(0, captionLineCount - 1) * 9.2;
      if (y - cardHeight - 10 < CONTENT_BOTTOM) { addPage(); section("Photographic record (continued)"); }
      preparedPair.forEach(({ photo, offset, captionLines }) => {
        const x = MARGIN + offset * (cardWidth + gap);
        page.drawRectangle({ x, y: y - cardHeight, width: cardWidth, height: cardHeight, borderColor: LINE, borderWidth: 0.7 });
        if (photo.image) {
          const scaled = photo.image.scaleToFit(cardWidth - 12, 132);
          page.drawImage(photo.image, { x: x + (cardWidth - scaled.width) / 2, y: y - 140 + (132 - scaled.height) / 2, width: scaled.width, height: scaled.height });
        } else page.drawText("Image unavailable", { x: x + 12, y: y - 72, font: regular, size: 9, color: SLATE });
        page.drawLine({ start: { x: x + 6, y: y - 146 }, end: { x: x + cardWidth - 6, y: y - 146 }, thickness: 0.5, color: LINE });
        page.drawText(`PHOTO ${index + offset + 1}`, { x: x + 8, y: y - 160, font: bold, size: 7, color: TEAL });
        drawTextLines(page, regular, captionLines, { x: x + 8, y: y - 174, size: 7.8, lineHeight: 9.2, color: INK });
      });
      y -= cardHeight + 10;
    }
  }

  pages.forEach((item, index) => {
    item.drawLine({ start: { x: MARGIN, y: 46 }, end: { x: PAGE[0] - MARGIN, y: 46 }, thickness: 0.6, color: LINE });
    item.drawText("NEXPORT PTE LTD | Daily inspection record", { x: MARGIN, y: 29, font: regular, size: 7.2, color: SLATE });
    const prepared = `Prepared by ${clean(report.preparedBy?.name)} | ${report.status === "final" ? "FINAL" : "DRAFT"}`;
    item.drawText(prepared, { x: (PAGE[0] - regular.widthOfTextAtSize(prepared, 7.2)) / 2, y: 29, font: regular, size: 7.2, color: SLATE });
    const count = `Page ${index + 1} of ${pages.length}`;
    item.drawText(count, { x: PAGE[0] - MARGIN - regular.widthOfTextAtSize(count, 7.2), y: 29, font: regular, size: 7.2, color: SLATE });
  });
  return Buffer.from(await pdf.save());
}
