import express from "express";
import {
  getAdminDashboard,
  getClientDashboard,
  getDashboardStats,
  getExpertDashboard,
  getProviderDashboard,
} from "../controllers/dashboardController.js";
import { allowRoles, requireAuth } from "../middlewares/authMiddleware.js";
import { requireApprovedClient } from "../middlewares/clientApprovalMiddleware.js";

const router = express.Router();

router.get("/", requireAuth, requireApprovedClient, getDashboardStats);
router.get("/client", requireAuth, requireApprovedClient, allowRoles(3), getClientDashboard);
router.get("/expert", requireAuth, allowRoles(2), getExpertDashboard);
router.get("/admin", requireAuth, allowRoles(1), getAdminDashboard);
router.get("/provider", requireAuth, allowRoles(4), getProviderDashboard);

export default router;
