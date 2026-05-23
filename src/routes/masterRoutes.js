import express from "express";
import {
  getSpecialties,
  getVesselTypes,
  getCertifications,
} from "../controllers/masterController.js";

const router = express.Router();

router.get("/specialties", getSpecialties);
router.get("/vessel-types", getVesselTypes);
router.get("/certifications", getCertifications);

export default router;