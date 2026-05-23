import express from "express";
import {
  createVessel,
  getVessels,
  getVesselById,
  updateVessel,
  deleteVessel,
} from "../controllers/vesselController.js";

const router = express.Router();

router.post("/", createVessel);
router.get("/", getVessels);
router.get("/:id", getVesselById);
router.patch("/:id", updateVessel);
router.delete("/:id", deleteVessel);

export default router;