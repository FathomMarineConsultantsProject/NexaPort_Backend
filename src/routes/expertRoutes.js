import express from "express";
import {
  getAllExperts,
  getExpertById,
  getExpertCvUrl,
  createExpertPhotoUploadUrl,
  updateExpertPhoto,
  createExpert,
  updateExpert,
  deleteExpert,
} from "../controllers/expertController.js";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";

const router = express.Router();

router.get("/", requireAuth, allowRoles(1, 2), getAllExperts);
router.get("/:id/cv-url", requireAuth, allowRoles(1), getExpertCvUrl);
router.post(
  "/:id/photo-upload-url",
  requireAuth,
  allowRoles(2),
  createExpertPhotoUploadUrl
);
router.patch("/:id/photo", requireAuth, allowRoles(2), updateExpertPhoto);
router.get("/:id", requireAuth, getExpertById);
router.post("/", requireAuth, allowRoles(1, 2), createExpert);
router.patch("/:id", requireAuth, allowRoles(1, 2), updateExpert);
router.delete("/:id", requireAuth, allowRoles(1), deleteExpert);

export default router;



// GET /api/experts = only admin
// GET /api/experts/:id = admin OR expert owner only
