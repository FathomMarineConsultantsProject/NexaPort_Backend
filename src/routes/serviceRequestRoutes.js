import express from "express";
import {
  createServiceRequest,
  getServiceRequests,
  getServiceRequestById,
  updateServiceRequest,
  deleteServiceRequest,
} from "../controllers/serviceRequestController.js";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";

const router = express.Router();

router.get("/", requireAuth, getServiceRequests);
router.get("/:id", requireAuth, getServiceRequestById);
router.post("/", requireAuth, allowRoles(1, 3), createServiceRequest);
router.put("/:id", requireAuth, allowRoles(1, 3), updateServiceRequest);
router.delete("/:id", requireAuth, allowRoles(1, 3), deleteServiceRequest);

export default router;