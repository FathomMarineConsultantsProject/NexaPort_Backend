import express from "express";
import {
  getSpecialties,
  getVesselTypes,
  getCertifications,
  getServiceRequestDropdowns,
} from "../controllers/masterController.js";

const router = express.Router();

router.get("/specialties", getSpecialties);
router.get("/vessel-types", getVesselTypes);
router.get("/certifications", getCertifications);
router.get("/service-request-dropdowns", getServiceRequestDropdowns);


export default router;