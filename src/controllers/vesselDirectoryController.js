import { getVesselDirectoryDetail, listVesselDirectory, listVesselDirectoryFlags } from "../services/vesselDirectoryService.js";
import { logDatabaseError } from "../config/databaseErrors.js";

export const listDirectoryFlags = async (_req, res) => {
  try { return res.json({ success: true, flags: await listVesselDirectoryFlags() }); }
  catch (error) { logDatabaseError("Vessel directory flags", error); return res.status(500).json({ success: false, message: "Vessel flags unavailable" }); }
};

export const listDirectoryVessels = async (req, res) => {
  try { return res.json({ success: true, ...await listVesselDirectory(req.query) }); }
  catch (error) { if (!error.status) logDatabaseError("Vessel directory list", error); return res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Vessel directory unavailable" }); }
};

export const getDirectoryVessel = async (req, res) => {
  try {
    const vessel = await getVesselDirectoryDetail(req.params.id);
    return vessel ? res.json({ success: true, vessel }) : res.status(404).json({ success: false, message: "Vessel not found" });
  } catch (error) { if (!error.status) logDatabaseError("Vessel directory detail", error); return res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Vessel directory unavailable" }); }
};
