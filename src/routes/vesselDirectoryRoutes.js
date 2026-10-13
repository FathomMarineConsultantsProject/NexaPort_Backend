import express from "express";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";
import { getDirectoryVessel, listDirectoryVessels } from "../controllers/vesselDirectoryController.js";

// One policy point for any future, explicitly approved directory visibility change.
export const VESSEL_DIRECTORY_ROLES = [1];
const router = express.Router();
router.use(requireAuth, allowRoles(...VESSEL_DIRECTORY_ROLES));
router.get("/", listDirectoryVessels);
router.get("/:id", getDirectoryVessel);
export default router;
