import express from "express";
import {
  createPort,
  getPorts,
  getPortById,
  updatePort,
  deletePort,
} from "../controllers/portController.js";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";

const router = express.Router();

router.get("/", requireAuth, getPorts);
router.get("/:id", requireAuth, getPortById);

router.post("/", requireAuth, allowRoles(1), createPort);
router.patch("/:id", requireAuth, allowRoles(1), updatePort);
router.delete("/:id", requireAuth, allowRoles(1), deletePort);

export default router;