import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PDFDocument, PDFName } from "pdf-lib";
import sharp from "sharp";
import {
  dailyReportFinalizationErrors, nextDailyReportNumber, normalizeDailyReportData, stageAllowsDailyReports, toIsoDate,
} from "../src/services/dailyReportService.js";
import { generateDailyReportPdf, prepareDailyReportImage } from "../src/services/dailyReportPdfService.js";
import { allowedCorsOrigins, corsOptions } from "../src/app.js";
import { sendDailyReportError } from "../src/controllers/dailyReportController.js";
import { WORKFLOW_STAGES } from "../src/services/inspectionWorkflowService.js";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");
const context = {
  request: { reference: "PSC-2026-0041", scope: "PSC preparation / Internal Audit / Class survey preparation", port: { name: "Trois-Rivieres", country: "Canada" } },
  vessel: { name: "IMPERIAL VARALAXMI", imoNumber: "9604040", type: "Bulk carrier", flag: "Panama" },
  surveyor: { id: 9, name: "Capt. Umang Sharma" },
  client: { id: 3, name: "Technical Manager" },
};
const completeData = {
  locationDetail: "Port of Trois-Rivieres, Quebec, Canada (Section 20)",
  inspectionScope: context.request.scope,
  boardingTime: "08:00", boardingDate: "2026-05-19", boardingLocation: "Trois-Rivieres, Quebec, Canada",
  activities: [{ id: "activity-1", description: "Documents verification" }], closingStatement: "",
};

test("Daily Reports become available at Preparation without adding a fourteenth stage", () => {
  assert.equal(WORKFLOW_STAGES.length, 13);
  assert.equal(stageAllowsDailyReports("surveyor"), false);
  for (const stage of WORKFLOW_STAGES.slice(4)) assert.equal(stageAllowsDailyReports(stage), true, stage);
});

test("Daily Report input persists source-specific repeatable activity rows", () => {
  const result = normalizeDailyReportData({ ...completeData, activities: [{ description: "Deck round taken" }, { id: "existing", description: "PMS inspected" }] });
  assert.equal(result.activities.length, 2);
  assert.match(result.activities[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(result.activities[1].id, "existing");
  assert.equal(result.activities[1].description, "PMS inspected");
});

test("Day sequence advances from Day 1 through Day N without a single-report blob", () => {
  assert.equal(nextDailyReportNumber(), 1);
  assert.equal(nextDailyReportNumber(1), 2);
  assert.equal(nextDailyReportNumber(36), 37);
  assert.throws(() => nextDailyReportNumber(-1), /sequence/);
});

test("invalid attendance time and unstructured activities are rejected", () => {
  assert.throws(() => normalizeDailyReportData({ ...completeData, boardingTime: "8am" }), /HH:mm/);
  assert.throws(() => normalizeDailyReportData({ ...completeData, activities: ["PMS inspected"] }), /structured row/);
});

test("finalization requires the real operational minimum but keeps remarks and photographs optional", () => {
  assert.deepEqual(dailyReportFinalizationErrors({ reportDate: "2026-05-19", data: completeData }, context), []);
  const fields = dailyReportFinalizationErrors({ reportDate: "2026-05-19", data: { ...completeData, boardingTime: "", activities: [] } }, context).map((item) => item.field);
  assert.deepEqual(fields, ["boardingTime", "activities"]);
});

test("multi-day migration enforces workflow sequence and date uniqueness with private photo linkage", async () => {
  const migration = await source("../sql/inspection_daily_reports_001.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.inspection_daily_reports/);
  assert.match(migration, /UNIQUE \(workflow_id, day_number\)/);
  assert.match(migration, /UNIQUE \(workflow_id, report_date\)/);
  assert.match(migration, /inspection_daily_report_photos/);
  assert.match(migration, /REFERENCES public\.inspection_daily_reports\(id\) ON DELETE CASCADE/);
  assert.doesNotMatch(migration, /content_html|report_text/);
});

test("create path serializes day allocation and final records are locked", async () => {
  const service = await source("../src/services/dailyReportService.js");
  assert.match(service, /getContext\(client, requestId, \{ lock: true \}\)/);
  assert.match(service, /MAX\(day_number\)/);
  assert.match(service, /DAILY_REPORT_DATE_CONFLICT/);
  assert.match(service, /Final Daily Reports are read-only/);
  for (const action of ["daily_report.created", "daily_report.updated", "daily_report.generated", "daily_report.finalized"]) assert.match(service, new RegExp(action.replace(".", "\\.")));
});

test("all Daily Report APIs inherit Super Admin-only workflow access and never return a raw photo key", async () => {
  const [routes, service] = await Promise.all([source("../src/routes/inspectionWorkflowRoutes.js"), source("../src/services/dailyReportService.js")]);
  assert.match(routes, /router\.use\(requireAuth,allowRoles\(1\)\)/);
  for (const endpoint of ["daily-reports\",list", "dailyReportId\",update", "dailyReportId\/generate", "dailyReportId\/finalize", "photos\/upload-url"]) assert.match(routes, new RegExp(endpoint));
  assert.match(service, /return \{ uploadId, uploadUrl:/);
  assert.doesNotMatch(service, /return \{ uploadId, objectKey/);
  assert.match(service, /createPresignedGetUrl\(\{ key, expiresInSeconds: 300 \}\)/);
});

test("professional Daily Report PDF is A4, multi-page, branded, and embeds evidence", async () => {
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const activities = Array.from({ length: 55 }, (_, index) => ({ id: `activity-${index}`, description: `Inspection activity ${index + 1}: ${"Long technical observation wraps safely within the activity ledger. ".repeat(3)}` }));
  const output = await generateDailyReportPdf({ report: { id: 1, dayNumber: 2, reportDate: "2026-05-20", status: "draft", data: { ...completeData, activities }, preparedBy: { name: "NexaPort Administrator" } }, context, photos: [{ bytes: pixel, caption: "Vessel at berth", inspectionArea: "Port side" }] });
  const pdf = await PDFDocument.load(output);
  const images = [...pdf.context.enumerateIndirectObjects()].filter(([, object]) => object?.dict?.get(PDFName.of("Subtype"))?.toString() === "/Image");
  assert.ok(pdf.getPageCount() >= 3);
  assert.ok(images.length >= 2);
  assert.deepEqual(pdf.getPage(0).getSize(), { width: 595.28, height: 841.89 });
  assert.match(pdf.getTitle(), /Daily Inspection Report - Day 2 - IMPERIAL VARALAXMI/);
  assert.ok(output.length > 100000);
});

test("Daily Report PDF generates without photographs", async () => {
  const output = await generateDailyReportPdf({ report: { id: 1, dayNumber: 1, reportDate: "2026-05-19", status: "draft", data: completeData, preparedBy: { name: "NexaPort Administrator" } }, context });
  const pdf = await PDFDocument.load(output);
  assert.ok(pdf.getPageCount() >= 1);
});

test("invalid or missing photograph data renders an unavailable placeholder instead of failing generation", async () => {
  const output = await generateDailyReportPdf({ report: { id: 1, dayNumber: 1, reportDate: "2026-05-19", status: "draft", data: completeData, preparedBy: { name: "NexaPort Administrator" } }, context, photos: [{ caption: "Missing S3 object" }, { bytes: Buffer.from("not-an-image") }] });
  assert.ok((await PDFDocument.load(output)).getPageCount() >= 1);
});

test("large camera images are constrained before PDF embedding", async () => {
  const sourceImage = await sharp({ create: { width: 5000, height: 3500, channels: 3, background: "#67747d" } }).jpeg({ quality: 95 }).toBuffer();
  const prepared = await prepareDailyReportImage(sourceImage);
  const metadata = await sharp(prepared.bytes).metadata();
  assert.equal(prepared.format, "jpeg");
  assert.ok(metadata.width <= 1600);
  assert.ok(metadata.height <= 1200);
  assert.ok(prepared.bytes.length < sourceImage.length);
});

test("private S3 photo retrieval is sequential, bounded, cached, and tolerates an unavailable object", async () => {
  const service = await source("../src/services/dailyReportService.js");
  assert.match(service, /for \(const photo of photoRows\)/);
  assert.match(service, /readPrivateObject\(key, 8 \* 1024 \* 1024\)/);
  assert.match(service, /const imageCache = new Map\(\)/);
  assert.match(service, /imageCache\.set\(key, preparedImage\)/);
  assert.match(service, /photograph unavailable during PDF generation/);
  assert.doesNotMatch(service, /Promise\.all\(photoRows/);
});

test("generation failures return a structured non-sensitive API error", () => {
  let status;
  let body;
  const originalError = console.error;
  console.error = () => {};
  try {
    sendDailyReportError({ status(value) { status = value; return this; }, json(value) { body = value; return this; } }, new Error("S3 secret path detail"), "DAILY_REPORT_GENERATION_FAILED");
  } finally { console.error = originalError; }
  assert.equal(status, 500);
  assert.deepEqual(body, { success: false, code: "DAILY_REPORT_GENERATION_FAILED", message: "Unable to process the Daily Report" });
});

test("localhost CORS permits both development hostnames and applies to normal errors", () => {
  assert.ok(allowedCorsOrigins.has("http://localhost:5173"));
  assert.ok(allowedCorsOrigins.has("http://127.0.0.1:5173"));
  for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173"]) {
    corsOptions.origin(origin, (error, allowed) => { assert.equal(error, null); assert.equal(allowed, true); });
  }
});

test("toIsoDate safely normalizes PostgreSQL Date instances, ISO strings, and raw dates without timezone shifts", () => {
  assert.equal(toIsoDate("2026-07-31"), "2026-07-31");
  assert.equal(toIsoDate("2026-07-31T00:00:00.000Z"), "2026-07-31");
  assert.equal(toIsoDate(new Date(2026, 6, 31)), "2026-07-31");
  assert.equal(toIsoDate(null), null);
  assert.equal(toIsoDate(undefined), null);
  assert.equal(toIsoDate(""), null);
  assert.equal(toIsoDate("invalid-date-string"), null);
});
