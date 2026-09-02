import express from "express";
import { searchPublicPorts } from "../controllers/publicPortController.js";

const router = express.Router();

router.get("/ports/search", searchPublicPorts);

export default router;
