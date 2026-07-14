import express from "express";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";
import {
  approveClientRegistration,
  getClientDocumentDownloadUrl,
  getClientRegistration,
  listClientRegistrations,
  rejectClientRegistration,
} from "../controllers/adminClientRegistrationController.js";

const router = express.Router();
router.use(requireAuth, allowRoles(1));
router.get("/", listClientRegistrations);
router.get("/:id", getClientRegistration);
router.get("/:clientProfileId/documents/:documentId/download-url", getClientDocumentDownloadUrl);
router.post("/:id/approve", approveClientRegistration);
router.post("/:id/reject", rejectClientRegistration);
export default router;
