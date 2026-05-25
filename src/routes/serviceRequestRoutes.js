import express from "express";
import {
  createServiceRequest,
  getServiceRequests,
  getServiceRequestById,
  updateServiceRequest,
  deleteServiceRequest,
} from "../controllers/serviceRequestController.js";

const router = express.Router();

router.get("/", getServiceRequests);
router.get("/:id", getServiceRequestById);
router.post("/", createServiceRequest);
router.put("/:id", updateServiceRequest);
router.delete("/:id", deleteServiceRequest);

export default router;