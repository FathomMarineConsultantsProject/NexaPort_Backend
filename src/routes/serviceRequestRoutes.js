import express from "express";
import {
  createServiceRequest,
  getServiceRequests,
  getServiceRequestById,
  updateServiceRequest,
  deleteServiceRequest,
  deleteAllServiceRequests,
  assignExpertsToRequest,
} from "../controllers/serviceRequestController.js";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";
import { requireApprovedClient } from "../middlewares/clientApprovalMiddleware.js";

const router = express.Router();

router.get("/", requireAuth, requireApprovedClient, getServiceRequests);
router.get("/:id", requireAuth, requireApprovedClient, getServiceRequestById);

router.post("/", requireAuth, requireApprovedClient, allowRoles(1, 3), createServiceRequest);
router.post("/:id/assign-experts", requireAuth, allowRoles(1), assignExpertsToRequest);

router.put("/:id", requireAuth, requireApprovedClient, allowRoles(1, 3), updateServiceRequest);
router.delete("/all", requireAuth, allowRoles(1), deleteAllServiceRequests);
router.delete("/:id", requireAuth, requireApprovedClient, allowRoles(1, 3), deleteServiceRequest);

export default router;
