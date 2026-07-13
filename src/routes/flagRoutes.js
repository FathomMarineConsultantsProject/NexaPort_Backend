import express from "express";
import {
  getFlagDirectory,
  getFlagInspector,
  getFlags,
} from "../controllers/flagController.js";
import { allowRoles, requireAuth } from "../middlewares/authMiddleware.js";

const router = express.Router();

router.get("/", getFlags);
router.get("/:flagSlug/directory", requireAuth, allowRoles(1), getFlagDirectory);
router.get(
  "/:flagSlug/inspectors/:inspectorId",
  requireAuth,
  allowRoles(1),
  getFlagInspector
);

export default router;
