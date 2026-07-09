import express from "express";
import {
  getExpertReviews,
  createExpertReview,
  updateExpertReview,
  deleteExpertReview,
} from "../controllers/expertReviewController.js";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";

const router = express.Router();

router.get("/:expertId/reviews", requireAuth, getExpertReviews);
router.post("/:expertId/reviews", requireAuth, allowRoles(3), createExpertReview);
router.patch("/reviews/:reviewId", requireAuth, allowRoles(3), updateExpertReview);
router.delete("/reviews/:reviewId", requireAuth, allowRoles(1), deleteExpertReview);

export default router;
