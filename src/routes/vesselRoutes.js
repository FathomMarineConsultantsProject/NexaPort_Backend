import express from "express";
import {
  createVessel,
  getVessels,
  getVesselById,
  updateVessel,
  deleteVessel,
} from "../controllers/vesselController.js";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";

const router = express.Router();

router.post("/", requireAuth, allowRoles(1, 3), createVessel);
router.get("/", requireAuth, allowRoles(1, 3), getVessels);
router.get("/:id", requireAuth, allowRoles(1, 3), getVesselById);
router.patch("/:id", requireAuth, allowRoles(1, 3), updateVessel);
router.delete("/:id", requireAuth, allowRoles(1, 3), deleteVessel);

export default router;