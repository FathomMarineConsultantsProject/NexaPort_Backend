import { pool } from "../config/db.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const listAdminNotifications = async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const [notifications, unread] = await Promise.all([
      pool.query(
        `
        SELECT id, type, entity_type, entity_id, title, message, payload, created_at, read_at
        FROM public.admin_notifications
        WHERE recipient_user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
        `,
        [req.user.id, limit]
      ),
      pool.query(
        `
        SELECT COUNT(*)::int AS count
        FROM public.admin_notifications
        WHERE recipient_user_id = $1 AND read_at IS NULL
        `,
        [req.user.id]
      ),
    ]);

    return res.json({
      success: true,
      data: notifications.rows,
      unread_count: unread.rows[0]?.count || 0,
    });
  } catch (error) {
    console.error("Failed to list admin notifications", {
      name: error?.name,
      code: error?.code,
    });
    return res.status(500).json({
      success: false,
      message: "Failed to load notifications.",
    });
  }
};

export const markAdminNotificationRead = async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!UUID_PATTERN.test(id)) {
    return res.status(400).json({ success: false, message: "Invalid notification ID." });
  }

  try {
    const result = await pool.query(
      `
      UPDATE public.admin_notifications
      SET read_at = COALESCE(read_at, NOW())
      WHERE id = $1 AND recipient_user_id = $2
      RETURNING id, read_at
      `,
      [id, req.user.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Notification not found." });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to mark notification read." });
  }
};

export const markAllAdminNotificationsRead = async (req, res) => {
  try {
    const result = await pool.query(
      `
      UPDATE public.admin_notifications
      SET read_at = NOW()
      WHERE recipient_user_id = $1 AND read_at IS NULL
      `,
      [req.user.id]
    );

    return res.json({ success: true, marked_read: result.rowCount });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to mark notifications read." });
  }
};
