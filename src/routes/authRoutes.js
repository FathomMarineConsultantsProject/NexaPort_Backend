import express from "express";
import { register, login, getMe } from "../controllers/authController.js";
import {
  presignConsultantUpload,
  registerConsultant,
} from "../controllers/consultantRegistrationController.js";
import { requireAuth } from "../middlewares/authMiddleware.js";

const router = express.Router();

router.post("/register", register);
router.post("/register-consultant/upload-url", presignConsultantUpload);
router.post("/register-consultant", registerConsultant);
router.post("/login", login);
router.get("/me", requireAuth, getMe);

export default router;
