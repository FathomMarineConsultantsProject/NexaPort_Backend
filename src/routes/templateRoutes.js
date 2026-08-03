import { Router } from "express";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";
import { createTemplate, createTemplateUploadUrl, createTemplateVersion, extractTemplate, getTemplate, getTemplateSourceUrl, listTemplates, updateTemplate } from "../controllers/templateController.js";
import { createReport } from "../controllers/reportController.js";

const router = Router();
router.use(requireAuth, allowRoles(1, 2));
router.get("/", listTemplates);
router.post("/upload-url", allowRoles(2), createTemplateUploadUrl);
router.post("/", allowRoles(2), createTemplate);
router.get("/:id", getTemplate);
router.get("/:id/source-url", getTemplateSourceUrl);
router.patch("/:id", allowRoles(2), updateTemplate);
router.post("/:id/extract", allowRoles(2), extractTemplate);
router.post("/:id/versions", allowRoles(2), createTemplateVersion);
router.post("/:id/reports", allowRoles(2), createReport);
export default router;
