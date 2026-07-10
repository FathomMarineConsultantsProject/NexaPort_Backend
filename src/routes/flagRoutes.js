import express from "express";
import {
  getFlagDirectory,
  getFlagInspector,
  getFlags,
} from "../controllers/flagController.js";
import { requireAuth } from "../middlewares/authMiddleware.js";

const router = express.Router();

router.get("/", getFlags);
router.get("/:flagSlug/directory", requireAuth, getFlagDirectory);
router.get("/:flagSlug/inspectors/:inspectorId", requireAuth, getFlagInspector);

export default router;
