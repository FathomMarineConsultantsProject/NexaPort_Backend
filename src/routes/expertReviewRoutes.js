import express from "express";
import {
  getExpertReviews,
  createExpertReview,
  deleteExpertReview,
} from "../controllers/expertReviewController.js";

const router = express.Router();

router.get("/:expertId/reviews", getExpertReviews);
router.post("/:expertId/reviews", createExpertReview);
router.delete("/reviews/:reviewId", deleteExpertReview);

export default router;