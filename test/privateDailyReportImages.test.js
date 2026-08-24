import assert from "node:assert/strict";
import test from "node:test";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { PDFDocument, PDFName } from "pdf-lib";
import sharp from "sharp";
import { materializeDailyReportPdf } from "../src/services/dailyReportService.js";
import { readPrivateObject, setPrivateObjectClientForTests } from "../src/services/privateObjectService.js";

process.env.AWS_REGION ||= "ap-southeast-1";
process.env.AWS_S3_BUCKET ||= "private-test-bucket";
process.env.AWS_ACCESS_KEY_ID ||= "test-key";
process.env.AWS_SECRET_ACCESS_KEY ||= "test-secret";
const body = (bytes) => ({ transformToByteArray: async () => bytes });

test("private objects are loaded as buffers through S3 GetObject with no preview URL", async () => {
  const jpeg = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#123456" } }).jpeg().toBuffer();
  let command;
  setPrivateObjectClientForTests({ send: async (value) => { command = value; return { ContentLength: jpeg.length, Body: body(jpeg) }; } });
  assert.deepEqual(await readPrivateObject("reports/photo.jpg"), jpeg);
  assert.ok(command instanceof GetObjectCommand);
  assert.deepEqual(command.input, { Bucket: "private-test-bucket", Key: "reports/photo.jpg" });
});

test("PDF pipeline embeds PNG bytes, supports multiple photos, and caches duplicate S3 keys", async () => {
  const png = await sharp({ create: { width: 32, height: 20, channels: 3, background: "#418b82" } }).png().toBuffer();
  let gets = 0;
  setPrivateObjectClientForTests({ send: async () => { gets += 1; return { ContentLength: png.length, Body: body(png) }; } });
  const context = { request: { reference: "DR-1", scope: "Inspection", port: { name: "Singapore", country: "Singapore" } }, vessel: { name: "Test Vessel", imoNumber: "1234567", type: "Cargo", flag: "Panama" }, surveyor: { name: "Inspector" }, client: { name: "Owner" } };
  const report = { id: 1, day_number: 1, report_date: "2026-08-24", data_jsonb: { locationDetail: "Singapore", inspectionScope: "Inspection", boardingTime: "08:00", boardingDate: "2026-08-24", boardingLocation: "Singapore", activities: [{ id: "a", description: "Checked" }], closingStatement: "" }, prepared_by_name: "Admin" };
  const photos = [{ id: 1, photo_s3_key: "same/photo.png", caption: "One" }, { id: 2, photo_s3_key: "same/photo.png", caption: "Two" }];
  const output = await materializeDailyReportPdf(report, context, photos, "draft");
  const pdf = await PDFDocument.load(output);
  const images = [...pdf.context.enumerateIndirectObjects()].filter(([, object]) => object?.dict?.get(PDFName.of("Subtype"))?.toString() === "/Image");
  assert.equal(gets, 1);
  assert.ok(images.length >= 3);
});

test("a missing S3 photo falls back without failing PDF generation", async () => {
  setPrivateObjectClientForTests({ send: async () => { throw Object.assign(new Error("missing"), { name: "NoSuchKey" }); } });
  const context = { request: { reference: "DR-2", scope: "Inspection", port: {} }, vessel: { name: "Test Vessel" }, surveyor: { name: "Inspector" }, client: {} };
  const report = { id: 2, day_number: 1, report_date: "2026-08-24", data_jsonb: { activities: [] }, prepared_by_name: "Admin" };
  const originalWarn = console.warn; console.warn = () => {};
  try { assert.ok((await materializeDailyReportPdf(report, context, [{ id: 1, photo_s3_key: "missing.jpg" }], "draft")).length > 0); }
  finally { console.warn = originalWarn; }
});
