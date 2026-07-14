import express from "express";
import {
  createQuotation,
  getQuotations,
  getQuotationById,
  updateQuotation,
  deleteQuotation,
  acceptQuotation,
} from "../controllers/quotationController.js";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";
import { requireApprovedClient } from "../middlewares/clientApprovalMiddleware.js";

const router = express.Router();

router.get("/", requireAuth, requireApprovedClient, getQuotations);
router.get("/:id", requireAuth, requireApprovedClient, getQuotationById);
router.post("/", requireAuth, allowRoles(1, 2), createQuotation);
router.put("/:id", requireAuth, allowRoles(1, 2), updateQuotation);
router.delete("/:id", requireAuth, allowRoles(1, 2), deleteQuotation);
router.patch("/:id/accept", requireAuth, allowRoles(1), acceptQuotation);

export default router;
