import express from "express";
import {
  createQuotation,
  getQuotations,
  getQuotationById,
  updateQuotation,
  deleteQuotation,
} from "../controllers/quotationController.js";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";

const router = express.Router();

router.get("/", requireAuth, getQuotations);
router.get("/:id", requireAuth, getQuotationById);
router.post("/", requireAuth, allowRoles(1, 2), createQuotation);
router.put("/:id", requireAuth, allowRoles(1, 2), updateQuotation);
router.delete("/:id", requireAuth, allowRoles(1, 2), deleteQuotation);

export default router;