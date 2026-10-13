import { randomBytes, randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import { writeAdminAudit } from "../services/adminAuditService.js";
import { userMayViewRequest } from "../services/requestVisibilityService.js";

const validId = (value) => /^[1-9]\d*$/.test(String(value || ""));
const validLocator = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const unavailable = (res) => res.status(404).json({ success: false, code: "LINK_UNAVAILABLE", message: "This link is no longer available." });
const denied = (res) => res.status(403).json({ success: false, code: "ACCESS_DENIED", message: "You don't have permission to view this inspection request." });
const correlationId = (req, res) => {
  req.shareCorrelationId ||= randomUUID();
  res.set("X-Request-ID", req.shareCorrelationId);
  return req.shareCorrelationId;
};
const safeIdentifier = (value) => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value) ? value : undefined;
const logShareFailure = (level, operation, error, requestCorrelationId) => {
  console[level]("Share database operation failed", {
    requestCorrelationId,
    operation,
    code: typeof error?.code === "string" && /^[A-Z0-9]{5,20}$/.test(error.code) ? error.code : "UNKNOWN",
    ...(safeIdentifier(error?.schema) && { schema: safeIdentifier(error.schema) }),
    ...(safeIdentifier(error?.table) && { table: safeIdentifier(error.table) }),
    ...(safeIdentifier(error?.constraint) && { constraint: safeIdentifier(error.constraint) }),
  });
};
const failed = (res, error, connectionFailed = false) => {
  const unavailable = connectionFailed || ["08000", "08001", "08003", "08004", "08006", "08007", "08P01", "ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT"].includes(error?.code);
  return res.status(unavailable ? 503 : 500).json({
    success: false,
    code: unavailable ? "SHARING_UNAVAILABLE" : "SHARING_DATABASE_ERROR",
    message: "Sharing is temporarily unavailable.",
  });
};
export const shareNoStore = (req, res, next) => { correlationId(req, res); res.set("Cache-Control", "no-store"); res.set("Referrer-Policy", "no-referrer"); next(); };
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
const writeShareAuditIfAvailable = async (db, actorUserId, action, requestId, requestCorrelationId) => {
  // A failed optional audit write must not abort the share transaction in PostgreSQL.
  await db.query("SAVEPOINT share_audit");
  try {
    const schema = await db.query("SELECT to_regclass('public.admin_audit_logs') AS audit_table");
    if (schema.rows[0]?.audit_table) {
      await writeAdminAudit(db, { actorUserId, action, targetType: "service_request", targetId: requestId });
    }
    await db.query("RELEASE SAVEPOINT share_audit");
  } catch (error) {
    await db.query("ROLLBACK TO SAVEPOINT share_audit");
    await db.query("RELEASE SAVEPOINT share_audit");
    logShareFailure("warn", "optional_audit", error, requestCorrelationId);
  }
};

export const copyRequestLink = async (req, res) => {
  const requestCorrelationId = correlationId(req, res);
  if (!validId(req.params.id)) return denied(res);
  let db;
  try { db = await pool.connect(); }
  catch (error) {
    logShareFailure("error", "connect", error, requestCorrelationId);
    return failed(res, error, true);
  }
  let operation = "begin";
  try {
    await db.query("BEGIN");
    operation = "lock_request";
    const request = (await db.query("SELECT id,requester_user_id FROM service_requests WHERE id=$1 FOR UPDATE", [req.params.id])).rows[0];
    if (!request || !canManage(request, req.user)) { await db.query("ROLLBACK"); return denied(res); }
    operation = "lookup_share";
    let share = (await db.query("SELECT * FROM service_request_shares WHERE service_request_id=$1 FOR UPDATE", [request.id])).rows[0];
    const reusable = share && !share.revoked_at && (!share.expires_at || new Date(share.expires_at) > new Date());
    if (!reusable) {
      const locator = randomBytes(32).toString("hex");
      if (share) {
        operation = "rotate_share";
        share = (await db.query(`UPDATE service_request_shares SET locator=$2,revoked_at=NULL,revoked_by_user_id=NULL,
          expires_at=NULL,rotated_at=now(),updated_at=now(),created_by_user_id=$3 WHERE id=$1 RETURNING *`,
          [share.id, locator, req.user.id])).rows[0];
      } else {
        operation = "insert_share";
        share = (await db.query(`INSERT INTO service_request_shares(service_request_id,locator,created_by_user_id)
          VALUES($1,$2,$3) RETURNING *`, [request.id, locator, req.user.id])).rows[0];
      }
      operation = "optional_audit";
      await writeShareAuditIfAvailable(db, req.user.id, "service_request.share_created", request.id, requestCorrelationId);
    }
    operation = "commit";
    await db.query("COMMIT");
    return res.json({ success: true, data: { locator: share.locator } });
  } catch (error) {
    logShareFailure("error", operation, error, requestCorrelationId);
    await db.query("ROLLBACK").catch((rollbackError) => logShareFailure("error", "rollback", rollbackError, requestCorrelationId));
    return failed(res, error);
  } finally { db.release(); }
};

export const resolveRequestLink = async (req, res) => {
  const requestCorrelationId = correlationId(req, res);
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
    logShareFailure("error", "resolve_share", error, requestCorrelationId);
    return failed(res, error);
  }
};

export const revokeRequestLink = async (req, res) => {
  const requestCorrelationId = correlationId(req, res);
  if (!validId(req.params.id)) return denied(res);
  let db;
  try { db = await pool.connect(); }
  catch (error) {
    logShareFailure("error", "connect", error, requestCorrelationId);
    return failed(res, error, true);
  }
  try {
    await db.query("BEGIN");
    const request = (await db.query("SELECT id,requester_user_id FROM service_requests WHERE id=$1 FOR UPDATE", [req.params.id])).rows[0];
    if (!request || !canManage(request, req.user)) { await db.query("ROLLBACK"); return denied(res); }
    const changed = await db.query(`UPDATE service_request_shares SET revoked_at=now(),revoked_by_user_id=$2,updated_at=now()
      WHERE service_request_id=$1 AND revoked_at IS NULL RETURNING id`, [request.id, req.user.id]);
    if (changed.rowCount) await writeShareAuditIfAvailable(db, req.user.id, "service_request.share_revoked", request.id, requestCorrelationId);
    await db.query("COMMIT");
    return res.json({ success: true });
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    logShareFailure("error", "revoke_share", error, requestCorrelationId);
    return failed(res, error);
  } finally { db.release(); }
};
