import express from "express";
import { getAppointedSurveyors } from "../controllers/appointedSurveyorController.js";
import { allowRoles, requireAuth } from "../middlewares/authMiddleware.js";

const router = express.Router();

router.get("/", requireAuth, allowRoles(1), getAppointedSurveyors);

export default router;
