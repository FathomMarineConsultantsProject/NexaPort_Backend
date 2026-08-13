import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateReportPdf } from "../src/services/pdfGenerationService.js";

const questions = [
  "Mooring arrangement is effective and suitable for the expected weather, tide and transfer conditions",
  "Firefighting equipment is ready for immediate use and all access routes remain unobstructed",
  "Emergency shutdown signals and communication procedures are understood by both vessel teams",
  "The restricted area is free of unauthorized personnel, ignition sources and unrelated equipment",
  "Appropriate personal protective equipment is identified, available and worn by assigned personnel",
  "Safety shower and eyewash equipment have been tested and are ready for immediate use",
  "Spill response arrangements are effective and suitable for methanol transfer operations",
  "Scuppers and save-alls are plugged, spill trays are empty and drainage valves are closed",
  "Unused bunker connections are blanked, fully bolted and confirmed free from leakage",
  "Weather and wave conditions remain inside the operational limits agreed in the JPBO",
  "Safe access between the vessels and between the receiving vessel and berth is maintained",
  "Operation supervision and watchkeeping arrangements are adequate for the full transfer period",
  "All transfer hoses and vapour return lines are properly supported and protected from damage",
  "Electrical insulation arrangements have been checked and remain effective at the connection",
  "Emergency release and shutdown systems are armed and available to the persons in charge",
  "Transfer pressure, temperature and flow rate remain within the agreed operating envelope",
  "Tank filling limits and valve line-up have been independently confirmed before transfer starts",
  "Continuous gas monitoring is operating at the agreed locations on both participating vessels",
  "Communications with the berth operator remain available throughout the bunker operation",
  "Simultaneous operations continue to comply with the restrictions recorded in the agreement",
  "No visible leakage is present at manifolds, hoses, couplings, valves or vapour return connections",
  "The transfer area remains adequately illuminated and emergency escape routes remain clear",
  "All relevant personnel have been notified before changing the transfer rate or stopping transfer",
  "Final transferred quantity has been reconciled and agreed by the persons in charge",
  "Transfer lines have been drained, purged, depressurized and made ready for disconnection",
  "The bunker area has been cleared and restored to its normal safe operating condition",
];

const fields = [
  { fieldKey: "bin", label: "Bunker Identification Number (BIN)", type: "text", section: "Preparation" },
  { fieldKey: "jpbo", label: "JPBO Version Number", type: "text", section: "Preparation" },
  { fieldKey: "inspection_date", label: "Inspection Date", type: "date", section: "Preparation" },
  { fieldKey: "port_berth", label: "Port and Berth", type: "text", section: "Preparation" },
  { fieldKey: "bunker_vessel", label: "Bunker Vessel", type: "text", section: "Preparation" },
  { fieldKey: "receiving_vessel", label: "Receiving Vessel", type: "text", section: "Preparation" },
  ...questions.map((label, index) => ({ fieldKey: `check_${index + 1}`, label, type: index % 6 === 0 ? "select" : "yes_no", options: index % 6 === 0 ? ["Yes", "No", "Not Applicable"] : ["Yes", "No"], section: index < 9 ? "B1 — Pre Operation (Bunker Vessel)" : index < 20 ? "E1 — Transfer (Bunker Vessel)" : "F1 — Post Operation (Bunker Vessel)" })),
  { fieldKey: "remarks", label: "Operational Remarks", type: "textarea", section: "Post Operation" },
  { fieldKey: "master_name", label: "Master Name", type: "text", section: "Declarations — Part F" },
  { fieldKey: "master_signature", label: "Master Signature", type: "signature", section: "Declarations — Part F" },
  { fieldKey: "declaration_date", label: "Date and Time", type: "date", section: "Declarations — Part F" },
];
const values = Object.fromEntries(fields.map((field, index) => [field.fieldKey, field.type === "yes_no" || field.type === "select" ? { answer: index % 7 === 0 ? "Not Applicable" : index % 5 === 0 ? "No" : "Yes", remarks: index % 8 === 0 ? "Verified after joint review." : "" } : ""]));
Object.assign(values, { bin: "BIN-2026-0417", jpbo: "JPBO-7.2", inspection_date: "2026-08-14", port_berth: "Mumbai Port — Berth 4", bunker_vessel: "MV Nexa Supply", receiving_vessel: "MV Ocean Meridian", remarks: "The operation was completed safely. One temporary pause was recorded while the transfer team reconfirmed manifold pressure and communications.", master_name: "Captain A. Sharma", declaration_date: "2026-08-14" });

const output = resolve("output/pdf/semantic-extraction-report-acceptance.pdf");
await mkdir(resolve("output/pdf"), { recursive: true });
await writeFile(output, await generateReportPdf({ title: "Methanol Bunkering Alongside a Berth — Inspection Report", fields, values, serviceRequest: { title: "AFM01 Methanol Bunkering Checklist", vessel_name: "MV Ocean Meridian", imo_number: "9876543", port_name: "Mumbai Port" }, status: "completed", versionNumber: 7, generatedAt: new Date("2026-08-14T10:30:00+05:30") }));
console.log(output);
