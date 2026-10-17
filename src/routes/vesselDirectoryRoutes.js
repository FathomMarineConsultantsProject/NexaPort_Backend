import express from "express";
import { randomUUID } from "node:crypto";
import { requireAuth, allowRoles } from "../middlewares/authMiddleware.js";
import { getDirectoryVessel, listDirectoryFlags, listDirectoryVessels } from "../controllers/vesselDirectoryController.js";

// One policy point for any future, explicitly approved directory visibility change.
export const VESSEL_DIRECTORY_ROLES = [1];
const router = express.Router();
router.use((req, res, next) => {
  if (req.method !== "GET" || req.path !== "/") return next();
  req.directoryTiming = { id: randomUUID(), started: process.hrtime.bigint() };
  res.setHeader("X-Request-ID", req.directoryTiming.id);
  console.info(JSON.stringify({ event: "vessel_directory", requestId: req.directoryTiming.id, stage: "function_entry" }));
  res.on("finish", () => console.info(JSON.stringify({ event: "vessel_directory", requestId: req.directoryTiming.id, stage: "response_completion", durationMs: Math.round(Number(process.hrtime.bigint() - req.directoryTiming.started) / 1e6), status: res.statusCode })));
  next();
});
router.use((req, res, next) => {
  const started = process.hrtime.bigint();
  requireAuth(req, res, () => {
    if (req.directoryTiming) console.info(JSON.stringify({ event: "vessel_directory", requestId: req.directoryTiming.id, stage: "authentication", durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6) }));
    next();
  });
}, allowRoles(...VESSEL_DIRECTORY_ROLES));
router.get("/flags", listDirectoryFlags);
router.get("/", listDirectoryVessels);
router.get("/:id", getDirectoryVessel);
export default router;
