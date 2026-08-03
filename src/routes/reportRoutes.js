import { Router } from "express";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";
import { createPhotoUploadUrl, generateReport, getReport, getReportDownloadUrl, listReports, registerPhoto, updateReport } from "../controllers/reportController.js";

const router = Router();
router.use(requireAuth, allowRoles(1, 2));
router.get("/", listReports);
router.get("/:id", getReport);
router.patch("/:id", allowRoles(2), updateReport);
router.post("/:id/photo-upload-url", allowRoles(2), createPhotoUploadUrl);
router.post("/:id/photos", allowRoles(2), registerPhoto);
router.post("/:id/generate", allowRoles(2), generateReport);
router.get("/:id/download-url", getReportDownloadUrl);
export default router;
