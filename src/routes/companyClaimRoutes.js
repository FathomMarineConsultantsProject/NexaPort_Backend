import express from "express";
import { allowRoles, requireAuth } from "../middlewares/authMiddleware.js";
import * as controller from "../controllers/companyClaimController.js";

export const publicCompanyRoutes = express.Router();
publicCompanyRoutes.get("/search", controller.search);
publicCompanyRoutes.get("/:id", controller.publicDetail);

export const companyClaimRoutes = express.Router();
companyClaimRoutes.use(requireAuth);
companyClaimRoutes.get("/mine", controller.mine);
companyClaimRoutes.get("/managed", controller.managed);
companyClaimRoutes.post("/evidence/upload-url", controller.uploadUrl);
companyClaimRoutes.post("/", controller.submit);

export const adminCompanyClaimRoutes = express.Router();
adminCompanyClaimRoutes.use(requireAuth, allowRoles(1));
adminCompanyClaimRoutes.get("/", controller.queue);
adminCompanyClaimRoutes.get("/:id", controller.detail);
adminCompanyClaimRoutes.get("/:id/evidence", controller.evidence);
adminCompanyClaimRoutes.post("/:id/approve", controller.approve);
adminCompanyClaimRoutes.post("/:id/reject", controller.reject);
