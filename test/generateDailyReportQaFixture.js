import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateDailyReportPdf } from "../src/services/dailyReportPdfService.js";

const activities = [
  "E/R blower flaps inspected.", "Funnel flaps inspected.", "All emergencies tried out.",
  "ECR alarm panel inspected.", "E/R bilge alarms tried out.", "OWS 15 ppm alarm and valve changeover checked.",
  "Fire alarm tested from different locations. General alarm tested.", "Emergency steering test carried out.",
  "STP operation and alarms checked.", "Status of LSA / FFA verified.",
  "BNWAS / fire detector panel / navigation lights / ECDIS / magnetic compass / EPIRB and SART checked.",
  "Low insulation alarms checked.", "Emergency fire pump operation checked.", "Load line items checked.",
  "Engine room documentation and emergency procedures checklists checked.", "Fixed fire fighting system inspected.",
  "Lifeboat inspected, engine tried out and inventories checked.", "Rescue boat swung out and lowered.",
  "Quick closing valve testing records and procedures checked.", "Fire alarm testing carried out and records checked.",
  "Galley and provision stores checked.",
].map((description, index) => ({ id: `day2-${index + 1}`, description }));

export async function createDailyReportQaFixture({ photoPaths = [], outputPath } = {}) {
  const photos = await Promise.all(photoPaths.map(async (photoPath, index) => ({ bytes: await readFile(photoPath), inspectionArea: index ? "Starboard quarter at berth" : "Port bow at berth", caption: index ? "Vessel secured alongside during inspection attendance." : "Vessel identification and external hull condition at commencement." })));
  const bytes = await generateDailyReportPdf({
    report: { id: 2, dayNumber: 2, reportDate: "2026-05-20", status: "final", preparedBy: { name: "Capt. Umang Sharma" }, data: {
      locationDetail: "Port of Trois-Rivieres, Quebec, Canada (Section 20)",
      inspectionScope: "PSC preparation / Internal Audit / Class survey preparation",
      boardingTime: "08:00", boardingDate: "2026-05-19", boardingLocation: "Trois-Rivieres, Quebec, Canada (Section 20)",
      activities,
      closingStatement: "Each identified deficiency was thoroughly reviewed and discussed with the ship's crew to ensure a clear understanding and to facilitate effective corrective measures. The crew has been instructed to prioritize rectification efforts based on the criticality of the deficiencies identified.",
    } },
    context: { request: { reference: "PSC-2026-0041", scope: "PSC preparation / Internal Audit / Class survey preparation", port: { name: "Trois-Rivieres", country: "Canada" } }, vessel: { name: "IMPERIAL VARALAXMI", imoNumber: "9604040", type: "Bulk carrier", flag: "Panama" }, surveyor: { name: "Capt. Umang Sharma" }, client: { name: "Not provided" } },
    photos,
  });
  const target = outputPath || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../output/pdf/daily-report-module-qa.pdf");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await createDailyReportQaFixture({ photoPaths: process.argv.slice(2) });
  console.log(output);
}

