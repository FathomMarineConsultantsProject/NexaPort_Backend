import { Router } from "express";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";
import { analyseTemplate, createTemplate, createTemplateVersion, duplicateTemplate, getTemplate, listTemplates, mapTemplateFields, updateTemplate } from "../controllers/templateController.js";
import { createReport } from "../controllers/reportController.js";
import multer from "multer";

const router = Router();
const analyseUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ].includes(file.mimetype)),
});
export const uploadTemplateDocument = (req, res, next) => analyseUpload.single("document")(req, res, (error) => {
  if (!error) return next();
  console.error("Template extraction failed", { stage: "upload", provider: null, status: 400, category: "DOCUMENT_PARSE_FAILED", message: String(error.message || "Upload rejected").slice(0, 160) });
  return res.status(400).json({ success: false, code: "DOCUMENT_PARSE_FAILED", message: "The document upload was rejected." });
});
router.use(requireAuth, allowRoles(1, 2));
router.get("/", listTemplates);
router.post("/", createTemplate);
router.post("/map-fields", mapTemplateFields);
router.post("/analyse", uploadTemplateDocument, analyseTemplate);
router.get("/:id", getTemplate);
router.patch("/:id", updateTemplate);
router.post("/:id/versions", createTemplateVersion);
router.post("/:id/duplicate", allowRoles(2), duplicateTemplate);
router.post("/:id/reports", createReport);
export default router;
