import { getVesselDirectoryDetail, listVesselDirectory, listVesselDirectoryFlags } from "../services/vesselDirectoryService.js";
import { logDatabaseError } from "../config/databaseErrors.js";

export const listDirectoryFlags = async (_req, res) => {
  try { return res.json({ success: true, flags: await listVesselDirectoryFlags() }); }
  catch (error) { logDatabaseError("Vessel directory flags", error); return res.status(500).json({ success: false, message: "Vessel flags unavailable" }); }
};

export const listDirectoryVessels = async (req, res) => {
  const timing = (stage, durationMs, code) => {
    if (req.directoryTiming) console.info(JSON.stringify({ event: "vessel_directory", requestId: req.directoryTiming.id, stage, durationMs, ...(code ? { code: /^[A-Z0-9_]{1,40}$/i.test(String(code)) ? code : "UNKNOWN" } : {}) }));
  };
  try {
    const result = await listVesselDirectory(req.query, undefined, timing);
    const serialization = process.hrtime.bigint();
    const body = JSON.stringify({ success: true, ...result });
    timing("response_serialization", Math.round(Number(process.hrtime.bigint() - serialization) / 1e6));
    return res.type("json").send(body);
  }
  catch (error) { if (!error.status) logDatabaseError("Vessel directory list", error); timing("failure", 0, error.code || "UNKNOWN"); return res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Vessel directory unavailable" }); }
};

export const getDirectoryVessel = async (req, res) => {
  try {
    const vessel = await getVesselDirectoryDetail(req.params.id);
    return vessel ? res.json({ success: true, vessel }) : res.status(404).json({ success: false, message: "Vessel not found" });
  } catch (error) { if (!error.status) logDatabaseError("Vessel directory detail", error); return res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Vessel directory unavailable" }); }
};
