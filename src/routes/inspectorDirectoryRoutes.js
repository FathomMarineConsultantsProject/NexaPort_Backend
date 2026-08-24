import express from "express";
import { searchInspectorDirectory } from "../controllers/inspectorDirectoryController.js";
import { allowRoles, requireAuth } from "../middlewares/authMiddleware.js";

const router = express.Router();
router.get("/inspectors/search", requireAuth, allowRoles(1), searchInspectorDirectory);
export default router;
