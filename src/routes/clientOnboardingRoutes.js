import express from "express";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";
import {
  confirmMyClientDocument,
  getMyClientOnboarding,
  presignMyClientDocument,
  resubmitMyClientOnboarding,
  updateMyClientOnboarding,
} from "../controllers/clientOnboardingController.js";

const router = express.Router();
router.use(requireAuth, allowRoles(3));
router.get("/me", getMyClientOnboarding);
router.patch("/me", updateMyClientOnboarding);
router.post("/documents/upload-url", presignMyClientDocument);
router.post("/documents/confirm", confirmMyClientDocument);
router.post("/resubmit", resubmitMyClientOnboarding);
export default router;
