import express from "express";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";
import {
  getConsultantDeletionImpact,
  updateConsultantAsAdmin,
  deleteConsultantAsAdmin,
  deactivateConsultantAsAdmin,
  listClientsAsAdmin,
  getClientAsAdmin,
  updateClientAsAdmin,
  getClientDeletionImpact,
  deleteClientAsAdmin,
  deactivateClientAsAdmin,
} from "../controllers/adminAdministrationController.js";

const router = express.Router();
router.use(requireAuth, allowRoles(1));

router.get("/consultants/:expertId/deletion-impact", getConsultantDeletionImpact);
router.patch("/consultants/:expertId", updateConsultantAsAdmin);
router.delete("/consultants/:expertId", deleteConsultantAsAdmin);
router.post("/consultants/:expertId/deactivate-anonymize", deactivateConsultantAsAdmin);

router.get("/clients", listClientsAsAdmin);
router.get("/clients/:userId/deletion-impact", getClientDeletionImpact);
router.get("/clients/:userId", getClientAsAdmin);
router.patch("/clients/:userId", updateClientAsAdmin);
router.delete("/clients/:userId", deleteClientAsAdmin);
router.post("/clients/:userId/deactivate-anonymize", deactivateClientAsAdmin);

export default router;
