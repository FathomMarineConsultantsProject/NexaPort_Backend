import express from "express";
import {
  createQuotation,
  getQuotations,
  getQuotationById,
  updateQuotation,
  updateQuotationStatus,
  deleteQuotation,
} from "../controllers/quotationController.js";

const router = express.Router();

router.get("/", getQuotations);
router.get("/:id", getQuotationById);
router.post("/", createQuotation);
router.put("/:id", updateQuotation);
router.patch("/:id/status", updateQuotationStatus);
router.delete("/:id", deleteQuotation);

export default router;