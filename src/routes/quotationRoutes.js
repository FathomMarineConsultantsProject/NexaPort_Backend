import express from "express";
import {
  createQuotation,
  getQuotations,
  getQuotationById,
  updateQuotation,
  deleteQuotation,
  acceptQuotation,
  getQuotationNegotiation,
  reviseQuotation,
  decideQuotation,
} from "../controllers/quotationController.js";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";
import { requireApprovedClient } from "../middlewares/clientApprovalMiddleware.js";

const router = express.Router();

router.get("/", requireAuth, requireApprovedClient, allowRoles(1, 2, 3), getQuotations);
router.get("/:id/negotiation", requireAuth, allowRoles(1, 2), getQuotationNegotiation);
router.post("/:id/revisions", requireAuth, allowRoles(2), reviseQuotation);
router.post("/:id/decisions", requireAuth, allowRoles(1), decideQuotation);
router.get("/:id", requireAuth, requireApprovedClient, allowRoles(1, 2, 3), getQuotationById);
router.post("/", requireAuth, allowRoles(1, 2), createQuotation);
router.put("/:id", requireAuth, allowRoles(1, 2), updateQuotation);
router.delete("/:id", requireAuth, allowRoles(1, 2), deleteQuotation);
router.patch("/:id/accept", requireAuth, allowRoles(1), acceptQuotation);

export default router;
