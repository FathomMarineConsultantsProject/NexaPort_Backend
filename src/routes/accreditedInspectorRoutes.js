import express from "express";
import {
  getAccreditationSchemes,
  getAccreditedInspectors,
} from "../controllers/accreditedInspectorController.js";
import { requireAuth } from "../middlewares/authMiddleware.js";

export const accreditationSchemeRouter = express.Router();
export const accreditedInspectorRouter = express.Router();

accreditationSchemeRouter.get("/", requireAuth, getAccreditationSchemes);
accreditedInspectorRouter.get(
  "/:schemeSlug",
  requireAuth,
  getAccreditedInspectors
);
