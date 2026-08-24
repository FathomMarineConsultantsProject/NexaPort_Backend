import { pool } from "../config/db.js";
import { searchInspectors } from "../services/inspectorDirectoryService.js";

export const searchInspectorDirectory = async (req, res) => {
  try {
    return res.json({ success: true, ...(await searchInspectors(pool, req.query)) });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error("Inspector directory search failed", { name: error.name, code: error.code });
    return res.status(status).json({ success: false, message: status === 400 ? error.message : "Failed to search inspector directory" });
  }
};
