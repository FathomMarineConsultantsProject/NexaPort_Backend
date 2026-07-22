import express from "express";
import { allowRoles, requireAuth } from "../middlewares/authMiddleware.js";
import {
  activateDirectoryEntity,
  approveDirectoryEntity,
  createDirectoryEntity,
  deactivateDirectoryEntity,
  getDirectoryEntity,
  listDirectory,
  rejectDirectoryEntity,
  updateDirectoryEntity,
} from "../controllers/maritimeDirectoryController.js";

const router = express.Router();
router.use(requireAuth, allowRoles(1));
router.get("/", listDirectory);
router.post("/", createDirectoryEntity);
router.get("/:entityId", getDirectoryEntity);
router.patch("/:entityId", updateDirectoryEntity);
router.post("/:entityId/approve", approveDirectoryEntity);
router.post("/:entityId/reject", rejectDirectoryEntity);
router.post("/:entityId/activate", activateDirectoryEntity);
router.post("/:entityId/deactivate", deactivateDirectoryEntity);

export default router;
