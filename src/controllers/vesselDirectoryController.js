import { getVesselDirectoryDetail, listVesselDirectory } from "../services/vesselDirectoryService.js";

export const listDirectoryVessels = async (req, res) => {
  try { return res.json({ success: true, ...await listVesselDirectory(req.query) }); }
  catch (error) { return res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Vessel directory unavailable" }); }
};

export const getDirectoryVessel = async (req, res) => {
  try {
    const vessel = await getVesselDirectoryDetail(req.params.id);
    return vessel ? res.json({ success: true, vessel }) : res.status(404).json({ success: false, message: "Vessel not found" });
  } catch (error) { return res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Vessel directory unavailable" }); }
};
