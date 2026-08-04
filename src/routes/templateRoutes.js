import { Router } from "express";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";
import { createTemplate, createTemplateVersion, duplicateTemplate, getTemplate, listTemplates, mapTemplateFields, updateTemplate } from "../controllers/templateController.js";
import { createReport } from "../controllers/reportController.js";

const router = Router();
router.use(requireAuth, allowRoles(1, 2));
router.get("/", listTemplates);
router.post("/", createTemplate);
router.post("/map-fields", mapTemplateFields);
router.get("/:id", getTemplate);
router.patch("/:id", updateTemplate);
router.post("/:id/versions", createTemplateVersion);
router.post("/:id/duplicate", allowRoles(2), duplicateTemplate);
router.post("/:id/reports", createReport);
export default router;
