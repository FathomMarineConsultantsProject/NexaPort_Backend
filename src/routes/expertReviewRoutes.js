import express from "express";
import {
  getExpertReviews,
  createExpertReview,
  deleteExpertReview,
} from "../controllers/expertReviewController.js";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";

const router = express.Router();

router.get("/:expertId/reviews", requireAuth, getExpertReviews);
router.post("/:expertId/reviews", requireAuth, allowRoles(1, 3), createExpertReview);
router.delete("/reviews/:reviewId", requireAuth, allowRoles(1), deleteExpertReview);

export default router;