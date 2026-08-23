import express from "express";
import {
  approveServiceRequest,
  assignExpertsToRequest,
  createServiceRequest,
  deleteServiceRequest,
  getServiceRequestById,
  getServiceRequests,
  rejectServiceRequest,
  updateServiceRequest,
} from "../controllers/serviceRequestController.js";
import {
  approveProposal,
  getActiveProposal,
  listProposals,
  recallProposal,
  rejectProposal,
  saveDraft,
  sendProposal,
} from "../controllers/commercialProposalController.js";
import { allowRoles, requireAuth } from "../middlewares/authMiddleware.js";
import { requireApprovedClient } from "../middlewares/clientApprovalMiddleware.js";

const router = express.Router();

router.get("/", requireAuth, requireApprovedClient, getServiceRequests);
router.get("/:id", requireAuth, requireApprovedClient, getServiceRequestById);

// Commercial proposals
router.get("/:id/proposal", requireAuth, requireApprovedClient, getActiveProposal);
router.get("/:id/proposals", requireAuth, allowRoles(1), listProposals);
router.post("/:id/proposal/draft", requireAuth, allowRoles(1), saveDraft);
router.post("/:id/proposal/send", requireAuth, allowRoles(1), sendProposal);
router.post("/:id/proposal/supersede", requireAuth, allowRoles(1), recallProposal);
router.post("/:id/proposal/approve", requireAuth, requireApprovedClient, allowRoles(3), approveProposal);
router.post("/:id/proposal/reject", requireAuth, requireApprovedClient, allowRoles(3), rejectProposal);

router.post("/", requireAuth, requireApprovedClient, allowRoles(1, 3), createServiceRequest);
router.post("/:id/assign-experts", requireAuth, allowRoles(1), assignExpertsToRequest);
router.post("/:id/approve", requireAuth, allowRoles(1), approveServiceRequest);
router.post("/:id/reject", requireAuth, allowRoles(1), rejectServiceRequest);

router.put("/:id", requireAuth, requireApprovedClient, allowRoles(1, 3), updateServiceRequest);
router.delete("/:id", requireAuth, requireApprovedClient, allowRoles(1, 3), deleteServiceRequest);

export default router;
