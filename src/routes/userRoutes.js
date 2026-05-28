import express from "express";
import {
  getMyProfile,
  updateMyProfile,
} from "../controllers/userController.js";
import { requireAuth } from "../middlewares/authMiddleware.js";

const router = express.Router();

router.get("/me", requireAuth, getMyProfile);
router.patch("/me", requireAuth, updateMyProfile);

export default router;