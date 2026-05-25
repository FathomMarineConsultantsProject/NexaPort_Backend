import express from "express";
import {
  createPort,
  getPorts,
  getPortById,
  updatePort,
  deletePort,
} from "../controllers/portController.js";

const router = express.Router();

router.post("/", createPort);
router.get("/", getPorts);
router.get("/:id", getPortById);
router.patch("/:id", updatePort);
router.delete("/:id", deletePort);

export default router;