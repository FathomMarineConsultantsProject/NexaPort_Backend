import express from "express";
import { confirmCompanyLogo, getCompanyProfile, presignCompanyLogo, updateCompanyProfile } from "../controllers/maritimeCompanyController.js";
import { allowRoles, requireAuth } from "../middlewares/authMiddleware.js";

const router = express.Router();
router.use(requireAuth, allowRoles(4));
router.get("/profile", getCompanyProfile);
router.patch("/profile", updateCompanyProfile);
router.post("/logo/upload-url", presignCompanyLogo);
router.post("/logo/confirm", confirmCompanyLogo);

export default router;
