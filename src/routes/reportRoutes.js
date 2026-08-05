import { Router, raw } from "express";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";
import { generateReport, getReport, getReportDownloadUrl, listReports, updateReport } from "../controllers/reportController.js";

const router = Router();
router.use(requireAuth, allowRoles(1, 2));
router.get("/", listReports);
router.get("/:id", getReport);
router.patch("/:id", updateReport);
router.post("/:id/generate", raw({ type: "application/vnd.nexaport.report+json", limit: "30mb" }), generateReport);
router.get("/:id/download-url", getReportDownloadUrl);
export default router;
