import { createHash } from "node:crypto";

const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;

export const submissionHash = (body) => createHash("sha256").update(JSON.stringify(stable(
  Object.fromEntries(Object.entries(body).filter(([key]) => key !== "submissionKey"))
))).digest("hex");

export async function reserveSubmission(db, userId, body) {
  if (body.submissionKey == null) return null; // Existing API clients remain compatible.
  if (typeof body.submissionKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.submissionKey))
    throw Object.assign(new Error("Invalid submission key."), { status: 400 });
  const hash = submissionHash(body);
  const insert = await db.query(`INSERT INTO service_request_submissions(requester_user_id,submission_key,payload_hash)
    VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING submission_key`, [userId, body.submissionKey, hash]);
  if (insert.rowCount) return { key: body.submissionKey, hash, replay: null };
  const existing = (await db.query(`SELECT payload_hash,response FROM service_request_submissions
    WHERE requester_user_id=$1 AND submission_key=$2 FOR UPDATE`, [userId, body.submissionKey])).rows[0];
  if (!existing || existing.payload_hash !== hash || !existing.response)
    throw Object.assign(new Error("This submission key was already used for a different or incomplete request."), { status: 409 });
  return { key: body.submissionKey, hash, replay: existing.response };
}

export async function completeSubmission(db, userId, reservation, requestId, response) {
  if (!reservation) return;
  await db.query(`UPDATE service_request_submissions SET request_id=$3,response=$4::jsonb
    WHERE requester_user_id=$1 AND submission_key=$2`, [userId, reservation.key, requestId, JSON.stringify(response)]);
}
