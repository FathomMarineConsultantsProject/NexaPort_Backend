import { randomBytes } from "node:crypto";
import { pool } from "../config/db.js";
import { writeAdminAudit } from "../services/adminAuditService.js";
import { userMayViewRequest } from "../services/requestVisibilityService.js";

const validId = (value) => /^[1-9]\d*$/.test(String(value || ""));
const validLocator = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const unavailable = (res) => res.status(404).json({ success: false, code: "LINK_UNAVAILABLE", message: "This link is no longer available." });
const denied = (res) => res.status(403).json({ success: false, code: "ACCESS_DENIED", message: "You don't have permission to view this inspection request." });
const failed = (res) => res.status(503).json({ success: false, message: "Sharing is temporarily unavailable." });
export const shareNoStore = (_req, res, next) => { res.set("Cache-Control", "no-store"); res.set("Referrer-Policy", "no-referrer"); next(); };
const resolutionAttempts = new Map();
export const limitShareResolution = (req, res, next) => {
  const key = req.ip || "unknown";
  const now = Date.now();
  const current = resolutionAttempts.get(key);
  const slot = !current || current.until < now ? { count: 0, until: now + 60_000 } : current;
  slot.count += 1;
  resolutionAttempts.set(key, slot);
  if (resolutionAttempts.size > 5000) for (const [ip, value] of resolutionAttempts) if (value.until < now) resolutionAttempts.delete(ip);
  if (slot.count > 60) return res.status(429).json({ success: false, message: "Too many requests. Try again shortly." });
  next();
};
const canManage = (request, user) => Number(user.role_id) === 1 ||
  (Number(user.role_id) === 3 && Number(request.requester_user_id) === Number(user.id));

export const copyRequestLink = async (req, res) => {
  if (!validId(req.params.id)) return denied(res);
  const db = await pool.connect().catch(() => null);
  if (!db) return failed(res);
  try {
    await db.query("BEGIN");
    const request = (await db.query("SELECT id,requester_user_id FROM service_requests WHERE id=$1 FOR UPDATE", [req.params.id])).rows[0];
    if (!request || !canManage(request, req.user)) { await db.query("ROLLBACK"); return denied(res); }
    let share = (await db.query("SELECT * FROM service_request_shares WHERE service_request_id=$1 FOR UPDATE", [request.id])).rows[0];
    const reusable = share && !share.revoked_at && (!share.expires_at || new Date(share.expires_at) > new Date());
    if (!reusable) {
      const locator = randomBytes(32).toString("hex");
      if (share) {
        share = (await db.query(`UPDATE service_request_shares SET locator=$2,revoked_at=NULL,revoked_by_user_id=NULL,
          expires_at=NULL,rotated_at=now(),updated_at=now(),created_by_user_id=$3 WHERE id=$1 RETURNING *`,
          [share.id, locator, req.user.id])).rows[0];
      } else {
        share = (await db.query(`INSERT INTO service_request_shares(service_request_id,locator,created_by_user_id)
          VALUES($1,$2,$3) RETURNING *`, [request.id, locator, req.user.id])).rows[0];
      }
      await writeAdminAudit(db, { actorUserId: req.user.id, action: "service_request.share_created", targetType: "service_request", targetId: request.id });
    }
    await db.query("COMMIT");
    return res.json({ success: true, data: { locator: share.locator } });
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    console.error("Share creation failed", { code: error.code || "UNKNOWN" });
    return failed(res);
  } finally { db.release(); }
};

export const resolveRequestLink = async (req, res) => {
  if (!validLocator(req.body?.locator)) return unavailable(res);
  try {
    const result = await pool.query(`SELECT sr.* FROM service_request_shares s
      JOIN service_requests sr ON sr.id=s.service_request_id
      WHERE s.locator=$1 AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now())`, [req.body.locator]);
    const request = result.rows[0];
    if (!request) return unavailable(res);
    if (!(await userMayViewRequest(pool, request, req.user))) return denied(res);
    return res.json({ success: true, data: { requestId: request.id } });
  } catch (error) {
    console.error("Share resolution failed", { code: error.code || "UNKNOWN" });
    return failed(res);
  }
};

export const revokeRequestLink = async (req, res) => {
  if (!validId(req.params.id)) return denied(res);
  const db = await pool.connect().catch(() => null);
  if (!db) return failed(res);
  try {
    await db.query("BEGIN");
    const request = (await db.query("SELECT id,requester_user_id FROM service_requests WHERE id=$1 FOR UPDATE", [req.params.id])).rows[0];
    if (!request || !canManage(request, req.user)) { await db.query("ROLLBACK"); return denied(res); }
    const changed = await db.query(`UPDATE service_request_shares SET revoked_at=now(),revoked_by_user_id=$2,updated_at=now()
      WHERE service_request_id=$1 AND revoked_at IS NULL RETURNING id`, [request.id, req.user.id]);
    if (changed.rowCount) await writeAdminAudit(db, { actorUserId: req.user.id, action: "service_request.share_revoked", targetType: "service_request", targetId: request.id });
    await db.query("COMMIT");
    return res.json({ success: true });
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    console.error("Share revocation failed", { code: error.code || "UNKNOWN" });
    return failed(res);
  } finally { db.release(); }
};
