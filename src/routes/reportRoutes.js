import { Router } from "express";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";
import { createPhotoUploadUrl, generateReport, getReport, getReportDownloadUrl, listReports, registerPhoto, updateReport } from "../controllers/reportController.js";

const router = Router();
router.use(requireAuth, allowRoles(1, 2));
router.get("/", listReports);
router.get("/:id", getReport);
router.patch("/:id", updateReport);
router.post("/:id/photo-upload-url", createPhotoUploadUrl);
router.post("/:id/photos", registerPhoto);
router.post("/:id/generate", generateReport);
router.get("/:id/download-url", getReportDownloadUrl);
export default router;
