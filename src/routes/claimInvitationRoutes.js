import express from "express";
import { allowRoles, requireAuth } from "../middlewares/authMiddleware.js";
import * as controller from "../controllers/claimInvitationController.js";
export const publicClaimInvitationRoutes=express.Router();
publicClaimInvitationRoutes.get("/:token",controller.preview);
export const claimInvitationRoutes=express.Router();
claimInvitationRoutes.post("/:token/redeem",requireAuth,controller.redeem);
export const adminClaimInvitationRoutes=express.Router();
adminClaimInvitationRoutes.post("/",requireAuth,allowRoles(1),controller.issue);
