import express from "express";
import {
  createVessel,
  getVessels,
  getVesselById,
  updateVessel,
  deleteVessel,
  suggestRequestVessels,
} from "../controllers/vesselController.js";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";
import { requireApprovedClient } from "../middlewares/clientApprovalMiddleware.js";

const router = express.Router();

router.get("/request-suggestions", requireAuth, requireApprovedClient, allowRoles(1, 3), suggestRequestVessels);

router.post("/", requireAuth, requireApprovedClient, allowRoles(1, 3), createVessel);
router.get("/", requireAuth, requireApprovedClient, allowRoles(1, 3), getVessels);
router.get("/:id", requireAuth, requireApprovedClient, allowRoles(1, 3), getVesselById);
router.patch("/:id", requireAuth, requireApprovedClient, allowRoles(1, 3), updateVessel);
router.delete("/:id", requireAuth, requireApprovedClient, allowRoles(1, 3), deleteVessel);

export default router;
