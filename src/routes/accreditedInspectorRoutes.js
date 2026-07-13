import express from "express";
import {
  getAccreditationSchemes,
  getAccreditedInspectors,
} from "../controllers/accreditedInspectorController.js";
import { allowRoles, requireAuth } from "../middlewares/authMiddleware.js";

export const accreditationSchemeRouter = express.Router();
export const accreditedInspectorRouter = express.Router();

accreditationSchemeRouter.get(
  "/",
  requireAuth,
  allowRoles(1),
  getAccreditationSchemes
);
accreditedInspectorRouter.get(
  "/:schemeSlug",
  requireAuth,
  allowRoles(1),
  getAccreditedInspectors
);
