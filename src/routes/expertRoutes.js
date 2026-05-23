import express from "express";
import {
  getAllExperts,
  getExpertById,
  createExpert,
  updateExpert,
  deleteExpert,
} from "../controllers/expertController.js";

const router = express.Router();

router.get("/", getAllExperts);
router.get("/:id", getExpertById);
router.post("/", createExpert);
router.patch("/:id", updateExpert);
router.delete("/:id", deleteExpert);

export default router;