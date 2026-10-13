import { getAcceptedAgreement, requireAmendmentEligible } from "./commercialAmendmentService.js";
import { pool } from "../config/db.js";
import { writeAdminAudit } from "./adminAuditService.js";

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const id = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fail(400,"INVALID_ID","Invalid ID");
const money = (value, label, positive = false) => {
  const raw=String(value ?? "").trim();
  const n = Number(raw);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || !Number.isFinite(n) || (positive ? n <= 0 : n < 0) || n > 9999999999.99)
    fail(400,"INVALID_AMOUNT",`${label} must be a valid nonnegative amount with at most two decimals`);
  return n.toFixed(2);
};
const note = (value, max = 4000) => {
  const s = String(value ?? "").trim();
  if (s.length > max) fail(400,"NOTE_TOO_LONG",`Text must be at most ${max} characters`);
  return s || null;
};
export const validateRevision = (body = {}) => {
  const currency = String(body.currency || "USD").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency) || currency !== "USD") fail(400,"UNSUPPORTED_CURRENCY","Current quotation and proposal flow supports USD only");
  const baseFee = money(body.totalQuoteUsd,"Base fee",true);
  const travelCost = money(body.travelCost ?? 0,"Travel cost");
  const accommodationCost = money(body.accommodationCost ?? 0,"Accommodation cost");
  const reportFee = money(body.reportFee ?? 0,"Report fee");
  const urgencySurcharge = money(body.urgencySurcharge ?? 0,"Urgency surcharge");
  const days = body.attendanceDays == null || body.attendanceDays === "" ? null : Number(body.attendanceDays);
  if (days !== null && (!Number.isSafeInteger(days) || days <= 0)) fail(400,"INVALID_DAYS","Attendance days must be a positive integer");
  const total = ([baseFee,travelCost,accommodationCost,reportFee,urgencySurcharge].reduce((cents,v)=>cents+Math.round(Number(v)*100),0)/100).toFixed(2);
  if (Number(total) > 9999999999.99) fail(400,"INVALID_AMOUNT","Consultant total exceeds the supported amount");
  return { currency, baseFee, travelCost, accommodationCost, reportFee, urgencySurcharge, attendanceDays:days, consultantTotal:total, coverLetter:note(body.coverLetter) };
};
const revisionInsert = async (db, quotationId, version, actorId, v) => (await db.query(`
  INSERT INTO quotation_revisions (quotation_id,revision_number,submitted_by_user_id,currency,base_fee,attendance_days,travel_cost,accommodation_cost,report_fee,urgency_surcharge,consultant_total,cover_letter)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
  [quotationId,version,actorId,v.currency,v.baseFee,v.attendanceDays,v.travelCost,v.accommodationCost,v.reportFee,v.urgencySurcharge,v.consultantTotal,v.coverLetter])).rows[0];
const notify = async (db, recipient, type, entityId, title, message, payload = {}) => {
  await db.query(`INSERT INTO public.admin_notifications(recipient_user_id,type,entity_type,entity_id,title,message,payload)
    VALUES($1,$2,'quotation_revision',$3,$4,$5,$6::jsonb)
    ON CONFLICT(recipient_user_id,type,entity_type,entity_id) DO NOTHING`,
    [recipient,type,String(entityId),title,message,JSON.stringify(payload)]);
};
const requireNegotiationEligible = async (db, q) => {
  if (q.moderation_status !== "approved") fail(409,"REQUEST_NOT_AVAILABLE","Request is no longer eligible");
  if (String(q.request_status).toLowerCase()==="completed") fail(409,"FINANCIAL_ADJUSTMENT_REQUIRED","Completed requests require an explicit financial adjustment workflow, which is not supported.");
  const agreement = await getAcceptedAgreement(db, q.service_request_id);
  if (agreement) {
    if (Number(agreement.quotation_id) !== Number(q.id) || Number(agreement.expert_id) !== Number(q.expert_id))
      fail(409,"ASSIGNMENT_MISMATCH","Only the assigned Consultant quotation may be renegotiated");
    await requireAmendmentEligible(db, q.service_request_id);
  } else if (!["open","pending","active","pending_client_approval"].includes(String(q.request_status).toLowerCase()) || q.status === "accepted")
    fail(409,"REQUEST_NOT_AVAILABLE","Request is no longer eligible for negotiation");
};
export const mapReopenRequest = (r, actor) => ({id:r.id,revisionId:r.revision_id,decidedAt:r.decision_at,
  consultantMessage:r.consultant_message,reason:r.reason,suggestedMaxAmount:r.suggested_max_amount==null?null:Number(r.suggested_max_amount),
  suggestedMaxCurrency:r.suggested_max_currency,...(Number(actor.role_id)===1?{internalAdminNote:r.internal_admin_note}:{})});

export const createQuotationThread = async ({ actor, body }) => {
  const v = validateRevision(body), requestId=id(body.serviceRequestId);
  const db=await pool.connect();
  try {
    await db.query("BEGIN");
    const request=(await db.query("SELECT id,status,moderation_status FROM service_requests WHERE id=$1 FOR UPDATE",[requestId])).rows[0];
    if (!request) fail(404,"REQUEST_NOT_FOUND","Service request not found");
    if (request.moderation_status!=="approved" || !["open","pending","active"].includes(String(request.status).toLowerCase())) fail(409,"REQUEST_NOT_AVAILABLE","Request is not available for quotations");
    const expert=Number(actor.role_id)===2 ? (await db.query("SELECT id,user_id FROM experts WHERE user_id=$1",[actor.id])).rows[0]
      : (await db.query("SELECT id,user_id FROM experts WHERE id=$1",[id(body.expertId)])).rows[0];
    const expertId=expert?.id;
    if (!expertId || !expert.user_id) fail(403,"EXPERT_REQUIRED","Expert profile with a linked Consultant account is required");
    const existing=(await db.query("SELECT id FROM quotations WHERE service_request_id=$1 AND expert_id=$2",[requestId,expertId])).rows[0];
    if (existing) fail(409,"QUOTATION_EXISTS","A quotation already exists for this Expert and request");
    const q=(await db.query(`INSERT INTO quotations(service_request_id,expert_id,expert_user_id,total_quote_usd,attendance_days,travel_cost,accommodation_cost,report_fee,urgency_surcharge,cover_letter)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[requestId,expertId,expert.user_id,v.baseFee,v.attendanceDays,v.travelCost,v.accommodationCost,v.reportFee,v.urgencySurcharge,v.coverLetter])).rows[0];
    const revision=await revisionInsert(db,q.id,1,actor.id,v);
    await db.query("UPDATE quotations SET latest_revision_id=$1,internal_review_status='awaiting_review' WHERE id=$2",[revision.id,q.id]);
    await writeAdminAudit(db,{actorUserId:actor.id,action:"quotation.submitted",targetType:"quotation",targetId:q.id,summary:`Submitted quotation revision 1 for request ${requestId}`});
    await db.query(`INSERT INTO public.admin_notifications(recipient_user_id,type,entity_type,entity_id,title,message,payload)
      SELECT u.id,'quotation_submitted','quotation_revision',$1,'Quotation submitted','A Consultant quotation is ready for internal review.',$2::jsonb
      FROM users u WHERE u.is_active=true AND (u.role_id=1 OR EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id=u.id AND ur.role_id=1))
      ON CONFLICT(recipient_user_id,type,entity_type,entity_id) DO NOTHING`,[String(revision.id),JSON.stringify({request_id:requestId,quotation_id:q.id,revision_id:revision.id})]);
    await db.query("COMMIT");
    return { ...q, latest_revision_id:revision.id,internal_review_status:"awaiting_review" };
  } catch(e) { await db.query("ROLLBACK"); throw e; } finally { db.release(); }
};
export const getNegotiation = async ({ quotationId, actor }) => {
  const q=(await pool.query(`SELECT q.*,e.full_name AS expert_name FROM quotations q LEFT JOIN experts e ON e.id=q.expert_id WHERE q.id=$1`,[id(quotationId)])).rows[0];
  if (!q) fail(404,"QUOTATION_NOT_FOUND","Quotation not found");
  if (Number(actor.role_id)!==1 && !(Number(actor.role_id)===2 && Number(q.expert_user_id)===Number(actor.id))) fail(403,"ACCESS_DENIED","Quotation access denied");
  const rows=(await pool.query(`SELECT r.*,d.id AS decision_id,d.decision,d.actor_user_id,d.decision_at,d.reason,d.consultant_message,d.suggested_max_amount,d.suggested_max_currency,d.internal_admin_note
    FROM quotation_revisions r LEFT JOIN quotation_revision_decisions d ON d.revision_id=r.id WHERE r.quotation_id=$1 ORDER BY r.revision_number`,[q.id])).rows;
  const reopenRequests=(await pool.query(`SELECT rr.* FROM quotation_reopen_requests rr JOIN quotation_revisions r ON r.id=rr.revision_id WHERE r.quotation_id=$1 ORDER BY rr.id`,[q.id])).rows.map(r=>mapReopenRequest(r,actor));
  return { reopenRequests, id:q.id,serviceRequestId:q.service_request_id,expertId:q.expert_id,expertName:q.expert_name,status:q.status,internalStatus:q.internal_review_status,latestRevisionId:q.latest_revision_id,approvedRevisionId:q.approved_revision_id,revisions:rows.map(r=>({id:r.id,revisionNumber:r.revision_number,submittedByUserId:r.submitted_by_user_id,submittedAt:r.submitted_at,currency:r.currency,baseFee:Number(r.base_fee),attendanceDays:r.attendance_days,travelCost:Number(r.travel_cost),accommodationCost:Number(r.accommodation_cost),reportFee:Number(r.report_fee),urgencySurcharge:Number(r.urgency_surcharge),consultantTotal:Number(r.consultant_total),coverLetter:r.cover_letter,decision:r.decision?{id:r.decision_id,type:r.decision,actorUserId:r.actor_user_id,decidedAt:r.decision_at,reason:r.reason,consultantMessage:r.consultant_message,suggestedMaxAmount:r.suggested_max_amount==null?null:Number(r.suggested_max_amount),suggestedMaxCurrency:r.suggested_max_currency,...(Number(actor.role_id)===1?{internalAdminNote:r.internal_admin_note}:{})}:null})) };
};
export const submitQuotationRevision = async ({ quotationId, actor, body }) => {
  const v=validateRevision(body), expected=id(body.expectedRevisionId), db=await pool.connect();
  try { await db.query("BEGIN");
    const requestId=(await db.query("SELECT service_request_id FROM quotations WHERE id=$1",[id(quotationId)])).rows[0]?.service_request_id;
    if (!requestId) fail(404,"QUOTATION_NOT_FOUND","Quotation not found");
    await db.query("SELECT id FROM service_requests WHERE id=$1 FOR UPDATE",[requestId]);
    const q=(await db.query("SELECT q.*,sr.moderation_status,sr.status AS request_status FROM quotations q JOIN service_requests sr ON sr.id=q.service_request_id WHERE q.id=$1 FOR UPDATE OF q",[id(quotationId)])).rows[0];
    if (!q) fail(404,"QUOTATION_NOT_FOUND","Quotation not found");
    if (Number(actor.role_id)!==2 || Number(q.expert_user_id)!==Number(actor.id)) fail(403,"ACCESS_DENIED","Quotation access denied");
    if (q.internal_review_status!=="revision_requested" || !["pending","submitted","accepted"].includes(q.status) || Number(q.latest_revision_id)!==expected) fail(409,"STALE_REVISION","Latest revision has not been requested or has changed");
    await requireNegotiationEligible(db,q);
    const previous=(await db.query("SELECT revision_number FROM quotation_revisions WHERE id=$1",[expected])).rows[0];
    const revision=await revisionInsert(db,q.id,previous.revision_number+1,actor.id,v);
    if (q.status === "accepted") {
      // Operational quotation mirrors remain the last Client-approved agreement.
      await db.query("UPDATE quotations SET latest_revision_id=$1,approved_revision_id=NULL,internal_review_status='awaiting_review',updated_at=CURRENT_TIMESTAMP WHERE id=$2",[revision.id,q.id]);
    } else {
    await db.query(`UPDATE quotations SET latest_revision_id=$1,approved_revision_id=NULL,internal_review_status='awaiting_review',total_quote_usd=$2,attendance_days=$3,travel_cost=$4,accommodation_cost=$5,report_fee=$6,urgency_surcharge=$7,cover_letter=$8,updated_at=CURRENT_TIMESTAMP WHERE id=$9`,[revision.id,v.baseFee,v.attendanceDays,v.travelCost,v.accommodationCost,v.reportFee,v.urgencySurcharge,v.coverLetter,q.id]);
    }
    await writeAdminAudit(db,{actorUserId:actor.id,action:"quotation.revised",targetType:"quotation",targetId:q.id,summary:`Submitted quotation revision ${revision.revision_number}`});
    await db.query(`INSERT INTO public.admin_notifications(recipient_user_id,type,entity_type,entity_id,title,message,payload)
      SELECT u.id,'quotation_revision_submitted','quotation_revision',$1,'Revised quotation submitted','A Consultant submitted a revised quotation for review.',$2::jsonb FROM users u WHERE u.is_active=true AND (u.role_id=1 OR EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id=u.id AND ur.role_id=1)) ON CONFLICT(recipient_user_id,type,entity_type,entity_id) DO NOTHING`,[String(revision.id),JSON.stringify({request_id:q.service_request_id,quotation_id:q.id,revision_id:revision.id})]);
    await db.query("COMMIT"); return revision;
  } catch(e) { await db.query("ROLLBACK"); throw e; } finally { db.release(); }
};
export const decideQuotationRevision = async ({ quotationId, actor, body }) => {
  if (Number(actor.role_id)!==1) fail(403,"ACCESS_DENIED","Super Admin access is required");
  const decision=String(body.decision||"");
  if (!["revision_requested","approved","rejected"].includes(decision)) fail(400,"INVALID_DECISION","Invalid decision");
  const expected=id(body.revisionId), message=note(body.consultantMessage), reason=note(body.reason), internal=note(body.internalAdminNote);
  if (decision==="revision_requested" && !message) fail(400,"MESSAGE_REQUIRED","Negotiation message is required");
  if (decision==="rejected" && !message && !reason) fail(400,"REJECTION_REASON_REQUIRED","A Consultant-facing message or reason is required");
  const max=body.suggestedMaxAmount==null||body.suggestedMaxAmount===""?null:money(body.suggestedMaxAmount,"Suggested maximum",true);
  if (max!==null && decision!=="revision_requested") fail(400,"INVALID_SUGGESTION","Suggested maximum applies only to revision requests");
  const currency=max===null?null:String(body.suggestedMaxCurrency||"").trim().toUpperCase();
  if (max!==null && !/^[A-Z]{3}$/.test(currency)) fail(400,"CURRENCY_REQUIRED","Currency is required with suggested maximum");
  const db=await pool.connect();
  try { await db.query("BEGIN");
    const requestId=(await db.query("SELECT service_request_id FROM quotations WHERE id=$1",[id(quotationId)])).rows[0]?.service_request_id;
    if (!requestId) fail(404,"QUOTATION_NOT_FOUND","Quotation not found");
    await db.query("SELECT id FROM service_requests WHERE id=$1 FOR UPDATE",[requestId]);
    const q=(await db.query("SELECT q.*,sr.status AS request_status,sr.moderation_status FROM quotations q JOIN service_requests sr ON sr.id=q.service_request_id WHERE q.id=$1 FOR UPDATE OF q",[id(quotationId)])).rows[0];
    if (!q) fail(404,"QUOTATION_NOT_FOUND","Quotation not found");
    const reopening=decision==="revision_requested" && q.internal_review_status==="approved";
    if (Number(q.latest_revision_id)!==expected || (!reopening && q.internal_review_status!=="awaiting_review") || !["pending","submitted","accepted"].includes(q.status)) fail(409,"STALE_REVISION","Quotation revision is no longer awaiting review or eligible for reopening");
    await requireNegotiationEligible(db,q);
    const d=reopening
      ? (await db.query(`INSERT INTO quotation_reopen_requests(revision_id,actor_user_id,reason,consultant_message,suggested_max_amount,suggested_max_currency,internal_admin_note) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[expected,actor.id,reason,message,max,currency,internal])).rows[0]
      : (await db.query(`INSERT INTO quotation_revision_decisions(revision_id,decision,actor_user_id,reason,consultant_message,suggested_max_amount,suggested_max_currency,internal_admin_note) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[expected,decision,actor.id,reason,message,max,currency,internal])).rows[0];
    await db.query("UPDATE quotations SET internal_review_status=$1,approved_revision_id=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$3",[decision,decision==="approved"?expected:null,q.id]);
    await writeAdminAudit(db,{actorUserId:actor.id,action:`quotation.${decision}`,targetType:"quotation_revision",targetId:expected,summary:`${decision} quotation revision ${expected}`,reason});
    if (q.expert_user_id) await notify(db,q.expert_user_id,`quotation_${reopening?"reopened":decision}`,d.id,decision==="revision_requested"?"Quotation revision requested":decision==="approved"?"Quotation commercially approved":"Quotation rejected",decision==="revision_requested"?"Super Admin has requested a revised quotation.":decision==="approved"?"Your quotation has been commercially approved.":`Your quotation has been rejected.${message||reason?` ${String(message||reason).slice(0,300)}`:""}` ,{request_id:q.service_request_id,quotation_id:q.id,revision_id:expected,decision_id:d.id});
    await db.query("COMMIT"); return d;
  } catch(e) { await db.query("ROLLBACK"); throw e; } finally { db.release(); }
};
