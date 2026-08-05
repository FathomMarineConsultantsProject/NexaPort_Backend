import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { generateReportPdf } from "../src/services/pdfGenerationService.js";

const field = (fieldKey, label, type, section, required = false) => ({ fieldKey, label, type, section, required, defaultValue: "" });

export async function createPhase1PdfFixture() {
  const fields = [
    field("marina_name", "Marina Name", "text", "Inspection Information"), field("dock_number", "Dock/Pier Number", "text", "Inspection Information"),
    field("inspection_date", "Date", "date", "Inspection Information"), field("inspector", "Inspector Name", "text", "Inspection Information", true),
    ...Array.from({ length: 34 }, (_, index) => field(`check_${index + 1}`, `Inspection item ${index + 1} remains safe, accessible, correctly secured, and free from visible operational defects?`, "yes_no", index < 18 ? "Dock Structure" : "Equipment Verification", true)),
    field("observations", "Observations and Recommended Actions", "textarea", "Summary & Sign-Off"),
    { ...field("photo_bow", "Bow access evidence", "photo", "Photo Evidence", true), captionEnabled: true },
    { ...field("photo_equipment", "Emergency equipment evidence", "photo", "Photo Evidence"), captionEnabled: true },
    field("signature", "Inspector Signature", "signature", "Summary & Sign-Off", true),
  ];
  const values = { marina_name: "Harbour Point Marina", dock_number: "Pier C-14", inspection_date: "2026-08-05", ...Object.fromEntries(Array.from({ length: 34 }, (_, index) => [`check_${index + 1}`, index % 4 ? "Yes" : "No"])), observations: "The primary access route remains serviceable. Minor surface wear was noted near the shore connection and should be included in the next planned maintenance window.\n\nEmergency equipment labels remain legible. Continue monthly checks and record replacement dates in the marina safety log." };
  const photoA = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 44, g: 111, b: 132 } } }).png().toBuffer();
  const photoB = await sharp({ create: { width: 900, height: 1100, channels: 3, background: { r: 197, g: 155, b: 73 } } }).png().toBuffer();
  const signature = await sharp(Buffer.from('<svg width="900" height="240" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><path d="M45 170 C170 20 180 220 315 75 S470 205 610 70 S730 175 850 85" fill="none" stroke="#071b39" stroke-width="10" stroke-linecap="round"/></svg>')).png().toBuffer();
  return generateReportPdf({ title: "Marina Dock Safety Inspection", fields, values, photos: [{ fieldKey: "photo_bow", type: "photo", label: "Bow access evidence", caption: "Clear access along the inspected pier.", mimeType: "image/png", bytes: photoA }, { fieldKey: "photo_equipment", type: "photo", label: "Emergency equipment evidence", caption: "Emergency station and surrounding access.", mimeType: "image/png", bytes: photoB }, { fieldKey: "signature", type: "signature", label: "Inspector Signature", mimeType: "image/png", bytes: signature }], serviceRequest: { title: "Annual marina safety verification", vessel_name: "Nexa Spirit", imo_number: "9876543", port_name: "Mumbai" }, status: "completed", versionNumber: 4, generatedAt: new Date("2026-08-05T06:11:33.358Z") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "output"); await mkdir(directory, { recursive: true });
  const output = path.join(directory, "phase1-inspection-report.pdf"); await writeFile(output, await createPhase1PdfFixture()); console.log(output);
}
