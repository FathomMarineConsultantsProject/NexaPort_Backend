import express from "express";
import { allowRoles, requireAuth } from "../middlewares/authMiddleware.js";
import * as controller from "../controllers/professionalClaimController.js";

export const publicProfessionalRoutes = express.Router();
publicProfessionalRoutes.get("/search",controller.search);
publicProfessionalRoutes.get("/:type/:id",controller.publicDetail);

export const professionalClaimRoutes = express.Router();
professionalClaimRoutes.use(requireAuth);
professionalClaimRoutes.get("/mine",controller.mine);
professionalClaimRoutes.get("/managed",controller.managed);
professionalClaimRoutes.get("/:type/:id/state",controller.state);
professionalClaimRoutes.get("/:type/:id/profile",controller.getOverlay);
professionalClaimRoutes.patch("/:type/:id/profile",controller.updateOverlay);
professionalClaimRoutes.post("/evidence/upload-url",controller.uploadUrl);
professionalClaimRoutes.post("/",controller.submit);

export const adminProfessionalClaimRoutes = express.Router();
adminProfessionalClaimRoutes.use(requireAuth,allowRoles(1));
adminProfessionalClaimRoutes.get("/",controller.queue);
adminProfessionalClaimRoutes.get("/targets/:type/:id",controller.targetStatus);
adminProfessionalClaimRoutes.get("/:id",controller.detail);
adminProfessionalClaimRoutes.get("/:id/evidence",controller.evidence);
adminProfessionalClaimRoutes.post("/:id/approve",controller.approve);
adminProfessionalClaimRoutes.post("/:id/reject",controller.reject);
adminProfessionalClaimRoutes.post("/:id/dispute",controller.dispute);
adminProfessionalClaimRoutes.post("/links/:type/:id/:userId/revoke",controller.revoke);
