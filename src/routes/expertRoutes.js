import express from "express";
import {
  getAllExperts,
  getExpertById,
  createExpert,
  updateExpert,
  deleteExpert,
} from "../controllers/expertController.js";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";

const router = express.Router();

router.get("/", requireAuth, getAllExperts);
router.get("/:id", requireAuth, getExpertById);
router.post("/", requireAuth, allowRoles(1, 2), createExpert);
router.patch("/:id", requireAuth, allowRoles(1, 2), updateExpert);
router.delete("/:id", requireAuth, allowRoles(1), deleteExpert);

export default router;