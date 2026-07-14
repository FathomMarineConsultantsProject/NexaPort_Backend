import express from "express";
import {
  listAdminNotifications,
  markAdminNotificationRead,
  markAllAdminNotificationsRead,
} from "../controllers/adminNotificationController.js";
import { allowRoles, requireAuth } from "../middlewares/authMiddleware.js";

const router = express.Router();

router.use(requireAuth, allowRoles(1));
router.get("/", listAdminNotifications);
router.patch("/read-all", markAllAdminNotificationsRead);
router.patch("/:id/read", markAdminNotificationRead);

export default router;
