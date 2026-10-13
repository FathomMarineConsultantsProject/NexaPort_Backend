import { resolveRequestCompany } from "./requestParticularsService.js";
import { requestPortsSql, requestPortCollection } from "./requestPortsService.js";
import { pool } from "../config/db.js";
import { writeAdminAudit } from "./adminAuditService.js";
import { calculateQuotationTotals } from "./quotationAcceptanceService.js";
import { getProposalsForRequest, getActiveProposalForRequest, mapProposalRow } from "./commercialProposalService.js";
import { createPresignedGetUrl } from "../utils/s3Presign.js";
import { getPhaseTwoWorkflowState } from "./inspectionWorkflowPhase2Service.js";
import { getInvoiceWorkflowState } from "./inspectionInvoiceService.js";

export const WORKFLOW_STAGES = Object.freeze([
  "overview", "quote", "confirm", "surveyor", "preparation", "checklist",
  "report", "review", "report_confirmation", "inspection_completed",
  "invoice_submitted", "invoice_approved", "invoice_paid",
]);
export const PHASE_ONE_STAGES = Object.freeze(WORKFLOW_STAGES.slice(0, 4));
export const AWAITING_QUOTATION_STATUSES = Object.freeze(["pending", "submitted"]);

const workflowError = (status, code, message) => Object.assign(new Error(message), { status, code });
export const requireApprovedWorkflowRequest = (request) => {
  if (request?.moderation_status !== "approved") {
    throw workflowError(409, "REQUEST_NOT_APPROVED", "The request must finish Admin moderation before an inspection workflow can be initialized.");
  }
  return request;
};
const positiveId = (value, name = "id") => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw workflowError(400, "INVALID_ID", `${name} must be a positive integer`);
  return parsed;
};
const serviceLabelSql = `CASE WHEN sr.service_type='Other' THEN COALESCE(NULLIF(TRIM(sr.service_type_other),''),'Other') ELSE COALESCE(NULLIF(TRIM(sr.service_type),''),sr.service_category) END`;

const mapQuote = (row) => {
  if (!row) return null;
  const approved = row.internal_review_status === "approved"
    ? row.revisions?.find((revision) => Number(revision.id) === Number(row.approved_revision_id)) : null;
  const financialSource = approved ? {
    total_quote_usd: approved.baseFee, travel_cost: approved.travelCost,
    accommodation_cost: approved.accommodationCost, report_fee: approved.reportFee,
    urgency_surcharge: approved.urgencySurcharge,
  } : row;
  const totals = calculateQuotationTotals(financialSource, row.admin_markup_usd || 0);
  return {
    id: row.id, serviceRequestId: row.service_request_id, expertId: row.expert_id,
    consultantName: row.expert_name, consultantRating: row.expert_rating == null ? null : Number(row.expert_rating),
    consultantLocation: row.expert_location, status: row.status, attendanceDays: row.attendance_days,
    internalStatus: row.internal_review_status, latestRevisionId: row.latest_revision_id,
    approvedRevisionId: row.approved_revision_id,
    revisions: row.revisions || [],
    currency: approved?.currency || "USD",
    baseFeeUsd: Number(financialSource.total_quote_usd || 0), travelCostUsd: Number(financialSource.travel_cost || 0),
    accommodationCostUsd: Number(financialSource.accommodation_cost || 0), reportFeeUsd: Number(financialSource.report_fee || 0),
    urgencySurchargeUsd: Number(financialSource.urgency_surcharge || 0), consultantTotalUsd: approved ? approved.consultantTotal : totals.consultantTotalUsd,
    adminMarkupUsd: Number(row.admin_markup_usd || 0), clientTotalUsd: Number(row.client_total_usd || totals.clientTotalUsd),
    coverLetter: row.cover_letter, createdAt: row.created_at, updatedAt: row.updated_at,
  };
};

const safePhotoUrl = (key) => {
  if (!key) return null;
  try { return createPresignedGetUrl({ key }).url; } catch { return null; }
};

const fetchWorkflowRow = async (queryable, requestId) => {
  const result = await queryable.query("SELECT * FROM inspection_workflows WHERE service_request_id=$1", [requestId]);
  return result.rows[0] || null;
};

export const inferInitialStage = (request) => {
  if ((request.accepted_quotation_id && (request.accepted_expert_id || request.assigned_expert_id)) || (String(request.status).toLowerCase() === "assigned" && request.assigned_expert_id)) return "surveyor";
  if (request.accepted_quotation_id) return "confirm";
  return "overview";
};

export const listInspectionWorkflows = async ({ search, stage, status } = {}) => {
  const values = [];
  const conditions = ["sr.moderation_status='approved'"];
  if (search) { values.push(`%${String(search).trim()}%`); conditions.push(`(sr.title ILIKE $${values.length} OR sr.vessel_name ILIKE $${values.length} OR sr.requester_name ILIKE $${values.length} OR sr.port_name ILIKE $${values.length})`); }
  if (stage && stage !== "all") { if (!WORKFLOW_STAGES.includes(stage)) throw workflowError(400,"INVALID_STAGE","Unknown workflow stage"); values.push(stage); conditions.push(`COALESCE(iw.current_stage,CASE WHEN sr.accepted_quotation_id IS NOT NULL AND sr.accepted_expert_id IS NOT NULL THEN 'surveyor' WHEN sr.accepted_quotation_id IS NOT NULL THEN 'confirm' ELSE 'overview' END)=$${values.length}`); }
  if (status && status !== "all") { values.push(status); conditions.push(`LOWER(sr.status)=LOWER($${values.length})`); }
  const result = await pool.query(
    `SELECT sr.id AS request_id,${requestPortsSql("sr")} AS selected_ports,sr.port_id,sr.country,sr.title,sr.requester_name AS client_name,sr.vessel_name,
       ${serviceLabelSql} AS service,sr.port_name,sr.required_by,sr.status AS request_status,
       sr.moderation_status,sr.approved_budget_usd,sr.accepted_quotation_id,sr.accepted_expert_id,
       COALESCE(sr.accepted_expert_id,accepted_q.expert_id,assignment.expert_id) AS operational_expert_id,
       operational_expert.full_name AS accepted_expert_name,
       quotation_counts.total AS quotations_total,
       quotation_counts.awaiting_review AS quotations_awaiting_review,
       iw.id AS workflow_id,COALESCE(iw.current_stage,CASE WHEN sr.accepted_quotation_id IS NOT NULL AND sr.accepted_expert_id IS NOT NULL THEN 'surveyor' WHEN sr.accepted_quotation_id IS NOT NULL THEN 'confirm' ELSE 'overview' END) AS current_stage,
       (SELECT ii.status FROM inspection_invoices ii WHERE ii.workflow_id=iw.id) AS invoice_status,
       COALESCE(iw.updated_at,sr.updated_at) AS updated_at
     FROM service_requests sr
     LEFT JOIN inspection_workflows iw ON iw.service_request_id=sr.id
     LEFT JOIN quotations accepted_q ON accepted_q.id=sr.accepted_quotation_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE q.status IN ('pending','submitted')
           AND q.internal_review_status='awaiting_review')::int AS awaiting_review
       FROM quotations q WHERE q.service_request_id=sr.id
     ) quotation_counts ON TRUE
     LEFT JOIN LATERAL (
       SELECT rea.expert_id FROM request_expert_assignments rea
       WHERE rea.service_request_id=sr.id
       ORDER BY rea.updated_at DESC NULLS LAST,rea.id DESC LIMIT 1
     ) assignment ON TRUE
     LEFT JOIN experts operational_expert
       ON operational_expert.id=COALESCE(sr.accepted_expert_id,accepted_q.expert_id,assignment.expert_id)
     WHERE ${conditions.join(" AND ")}
     ORDER BY COALESCE(iw.updated_at,sr.updated_at) DESC,sr.id DESC`, values);
  return result.rows.map((row) => ({
    requestId: row.request_id, reference: row.title || `Request #${row.request_id}`, clientName: row.client_name,
    vesselName: row.vessel_name, service: row.service, portName: row.port_name, ports: requestPortCollection(row), requiredBy: row.required_by,
    requestStatus: row.request_status, moderationStatus: row.moderation_status,
    approvedBudgetUsd: row.approved_budget_usd == null ? null : Number(row.approved_budget_usd),
    quotationsTotal: Number(row.quotations_total || 0),
    quotationsAwaitingReview: Number(row.quotations_awaiting_review || 0), acceptedQuotationId: row.accepted_quotation_id,
    acceptedExpert: row.operational_expert_id ? { id: row.operational_expert_id, name: row.accepted_expert_name } : null,
    workflowId: row.workflow_id, currentStage: row.current_stage, invoiceStatus: row.invoice_status || null, updatedAt: row.updated_at,
  }));
};

export const getInspectionWorkflow = async (requestIdValue, queryable = pool) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const requestResult = await queryable.query(
    `SELECT sr.*,${requestPortsSql("sr")} AS selected_ports,${serviceLabelSql} AS service_label,u.full_name AS client_user_name,u.email AS client_email,u.phone AS client_phone,
            (SELECT rea.expert_id FROM request_expert_assignments rea WHERE rea.service_request_id=sr.id ORDER BY rea.updated_at DESC,rea.id DESC LIMIT 1) AS assigned_expert_id
       FROM service_requests sr LEFT JOIN users u ON u.id=sr.requester_user_id WHERE sr.id=$1`, [requestId]);
  if (!requestResult.rows.length) throw workflowError(404,"REQUEST_NOT_FOUND","Service request not found");
  const request = requestResult.rows[0];
  if (request.moderation_status !== "approved") throw workflowError(409,"REQUEST_NOT_APPROVED","The request must finish Admin moderation before an inspection workflow can be opened.");
  const workflow = await fetchWorkflowRow(queryable, requestId);
  const quoteResult = await queryable.query(
    `SELECT q.*,e.full_name AS expert_name,e.rating AS expert_rating,e.base_location AS expert_location
       FROM quotations q LEFT JOIN experts e ON e.id=q.expert_id WHERE q.service_request_id=$1 ORDER BY q.created_at DESC`, [requestId]);
  const history = await queryable.query(`SELECT r.*,d.id AS decision_id,d.decision,d.decision_at,d.reason,d.consultant_message,
    d.suggested_max_amount,d.suggested_max_currency,d.internal_admin_note
    FROM quotation_revisions r LEFT JOIN quotation_revision_decisions d ON d.revision_id=r.id
    JOIN quotations q ON q.id=r.quotation_id WHERE q.service_request_id=$1 ORDER BY r.quotation_id,r.revision_number`,[requestId]);
  const byQuote = new Map();
  for (const r of history.rows) {
    const items=byQuote.get(Number(r.quotation_id)) || [];
    items.push({id:r.id,revisionNumber:r.revision_number,submittedAt:r.submitted_at,currency:r.currency,
      baseFee:Number(r.base_fee),attendanceDays:r.attendance_days,travelCost:Number(r.travel_cost),
      accommodationCost:Number(r.accommodation_cost),reportFee:Number(r.report_fee),urgencySurcharge:Number(r.urgency_surcharge),
      consultantTotal:Number(r.consultant_total),coverLetter:r.cover_letter,
      decision:r.decision?{id:r.decision_id,type:r.decision,decidedAt:r.decision_at,reason:r.reason,
        consultantMessage:r.consultant_message,suggestedMaxAmount:r.suggested_max_amount,
        suggestedMaxCurrency:r.suggested_max_currency,internalAdminNote:r.internal_admin_note}:null});
    byQuote.set(Number(r.quotation_id),items);
  }
  const quotations = quoteResult.rows.map(row=>mapQuote({...row,revisions:byQuote.get(Number(row.id)) || []}));
  const acceptedQuotation = quotations.find((q) => Number(q.id) === Number(request.accepted_quotation_id)) || quotations.find((q) => q.status === "accepted") || null;
  const selectedQuotation = quotations.find((q) => Number(q.id) === Number(workflow?.selected_quotation_id)) || null;
  let surveyor = null;
  const operationalExpertId = request.accepted_expert_id || request.assigned_expert_id;
  if (operationalExpertId) {
    const expertResult = await queryable.query(
      `SELECT e.id,e.full_name,e.biography,e.base_location,e.country,e.years_experience,e.rating,
              erd.discipline,erd.rank,erd.qualifications,erd.qualifications_other,erd.photo_s3_key,
              COALESCE((SELECT json_agg(ep.port_name ORDER BY ep.port_name) FROM expert_ports ep WHERE ep.expert_id=e.id),'[]'::json) AS ports,
              EXISTS(SELECT 1 FROM request_expert_assignments rea WHERE rea.service_request_id=$1 AND rea.expert_id=e.id) AS has_assignment
         FROM experts e LEFT JOIN expert_registration_details erd ON erd.expert_id=e.id WHERE e.id=$2`,
      [requestId, operationalExpertId]);
    if (expertResult.rows[0]) { const e=expertResult.rows[0]; surveyor={ id:e.id,name:e.full_name,biography:e.biography,discipline:e.discipline,rank:e.rank,yearsExperience:e.years_experience,location:[e.base_location,e.country].filter(Boolean).join(", "),ports:e.ports||[],qualifications:e.qualifications||[],qualificationsOther:e.qualifications_other,rating:e.rating==null?null:Number(e.rating),photoUrl:safePhotoUrl(e.photo_s3_key),hasAssignment:e.has_assignment }; }
  }
  const activeProposalRow = await getActiveProposalForRequest(requestId, queryable);
  const allProposalsRows = await getProposalsForRequest(requestId, queryable);
  const proposal = activeProposalRow ? mapProposalRow(activeProposalRow, { role_id: 1 }) : null;
  const proposals = allProposalsRows.map((r) => mapProposalRow(r, { role_id: 1 }));
  const phaseTwo=workflow?await getPhaseTwoWorkflowState(requestId,queryable):{preparation:{data:{},completed:false,locked:false},templates:[],checklist:null,report:null};
  const closeout=workflow?await getInvoiceWorkflowState(requestId,queryable):{inspectionCompletion:{completed:false,completedAt:null},invoice:null};
  const companyName = await resolveRequestCompany(queryable, request.requester_user_id);
  return {
    workflow: workflow ? { id:workflow.id,currentStage:workflow.current_stage,selectedQuotationId:workflow.selected_quotation_id,startedAt:workflow.started_at,completedAt:workflow.completed_at,createdAt:workflow.created_at,updatedAt:workflow.updated_at } : null,
    request: { id:request.id,reference:request.title||`Request #${request.id}`,title:request.title,inspectionMethodId:request.inspection_method_id==null?null:Number(request.inspection_method_id),inspectionVertical:request.service_category,serviceType:request.service_type,serviceCategory:request.service_category,serviceTypeOther:request.service_type_other,service:request.service_label,scope:request.scope_of_work,urgency:request.urgency,requiredBy:request.required_by,status:request.status,moderationStatus:request.moderation_status,approvedBudgetUsd:request.approved_budget_usd==null?null:Number(request.approved_budget_usd),vessel:{name:request.vessel_name,imoNumber:request.imo_number,type:request.vessel_type,flag:request.flag_state},terminalName:request.terminal_name||null,ports:requestPortCollection(request),agentDetails:{companyName:request.agent_company_name||null,contactName:request.agent_contact_name||null,email:request.agent_email||null,phone:request.agent_phone||null},port:{name:request.port_name,country:request.country,eta:request.eta,locationSummary:request.location_summary} },
    client: { id:request.requester_user_id,name:companyName||request.requester_name||request.client_user_name,companyVerified:Boolean(companyName),email:request.client_email,phone:request.client_phone },
    quotations,selectedQuotation,acceptedQuotation,surveyor,proposal,proposals,
    counts:{ quotationsAwaitingReview:quotations.filter((q)=>AWAITING_QUOTATION_STATUSES.includes(String(q.status).toLowerCase()) && q.internalStatus==="awaiting_review").length },
    operationalError: operationalExpertId && !surveyor ? "The accepted or assigned Consultant profile could not be loaded." : null,
    ...phaseTwo,
    ...closeout,
  };
};

export const initializeInspectionWorkflow = async ({ requestId: value, actorUserId }) => {
  const requestId=positiveId(value,"requestId"); const client=await pool.connect();
  try { await client.query("BEGIN");
    const locked=await client.query("SELECT sr.*,(SELECT rea.expert_id FROM request_expert_assignments rea WHERE rea.service_request_id=sr.id ORDER BY rea.updated_at DESC,rea.id DESC LIMIT 1) AS assigned_expert_id FROM service_requests sr WHERE sr.id=$1 FOR UPDATE",[requestId]);
    if(!locked.rows.length) throw workflowError(404,"REQUEST_NOT_FOUND","Service request not found");
    const request=locked.rows[0];
    requireApprovedWorkflowRequest(request);
    let workflow=await fetchWorkflowRow(client,requestId);
    if(!workflow){ const stage=inferInitialStage(request); const created=await client.query("INSERT INTO inspection_workflows(service_request_id,current_stage,selected_quotation_id,created_by_user_id) VALUES($1,$2,$3,$4) RETURNING *",[requestId,stage,request.accepted_quotation_id||null,actorUserId]); workflow=created.rows[0]; await writeAdminAudit(client,{actorUserId,action:"inspection_workflow.initialized",targetType:"inspection_workflow",targetId:workflow.id,summary:`Initialized request ${requestId} at ${stage}`}); }
    await client.query("COMMIT"); return getInspectionWorkflow(requestId);
  } catch(error){ try{await client.query("ROLLBACK");}catch{} throw error; } finally{client.release();}
};

export const advanceOverviewToQuote = async ({requestId:value,actorUserId}) => {
  const requestId=positiveId(value,"requestId"); const client=await pool.connect();
  try{await client.query("BEGIN"); const wf=await client.query("SELECT * FROM inspection_workflows WHERE service_request_id=$1 FOR UPDATE",[requestId]); if(!wf.rows.length)throw workflowError(404,"WORKFLOW_NOT_FOUND","Initialize the workflow first"); if(wf.rows[0].current_stage!=="overview")throw workflowError(409,"INVALID_TRANSITION","Workflow is not at Overview"); const count=await client.query("SELECT COUNT(*)::int AS count FROM quotations WHERE service_request_id=$1 AND status IN ('pending','submitted')",[requestId]); if(!Number(count.rows[0].count))throw workflowError(409,"QUOTATION_REQUIRED","A submitted quotation is required before this workflow can continue."); await client.query("UPDATE inspection_workflows SET current_stage='quote',updated_at=CURRENT_TIMESTAMP WHERE id=$1",[wf.rows[0].id]); await writeAdminAudit(client,{actorUserId,action:"inspection_workflow.quotation_review_started",targetType:"inspection_workflow",targetId:wf.rows[0].id,summary:`Moved request ${requestId} to quotation review`}); await client.query("COMMIT"); return getInspectionWorkflow(requestId);}catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
};

export const selectWorkflowQuotation = async ({requestId:value,quotationId:quoteValue,actorUserId}) => {
  const requestId=positiveId(value,"requestId"),quotationId=positiveId(quoteValue,"quotationId"); const client=await pool.connect();
  try{await client.query("BEGIN"); const wf=await client.query("SELECT * FROM inspection_workflows WHERE service_request_id=$1 FOR UPDATE",[requestId]); if(!wf.rows.length)throw workflowError(404,"WORKFLOW_NOT_FOUND","Initialize the workflow first"); if(!["quote","confirm"].includes(wf.rows[0].current_stage))throw workflowError(409,"INVALID_TRANSITION","Quotation selection is only available during Quote or Confirm"); const quote=await client.query("SELECT id,status,internal_review_status,latest_revision_id,approved_revision_id FROM quotations WHERE id=$1 AND service_request_id=$2 FOR UPDATE",[quotationId,requestId]); if(!quote.rows.length)throw workflowError(409,"QUOTATION_REQUEST_MISMATCH","Quotation does not belong to this request"); if(!AWAITING_QUOTATION_STATUSES.includes(String(quote.rows[0].status).toLowerCase()) || quote.rows[0].internal_review_status!=="approved" || Number(quote.rows[0].latest_revision_id)!==Number(quote.rows[0].approved_revision_id))throw workflowError(409,"QUOTATION_NOT_ELIGIBLE","Latest Consultant quotation revision requires internal approval"); await client.query("UPDATE inspection_workflows SET selected_quotation_id=$1,current_stage='confirm',updated_at=CURRENT_TIMESTAMP WHERE id=$2",[quotationId,wf.rows[0].id]); await writeAdminAudit(client,{actorUserId,action:"inspection_workflow.quotation_selected",targetType:"inspection_workflow",targetId:wf.rows[0].id,summary:`Selected quotation ${quotationId} for request ${requestId}`}); await client.query("COMMIT"); return getInspectionWorkflow(requestId);}catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
};

export const confirmWorkflowQuotation = async ({requestId:value,adminMarkupUsd,actorUserId}) => {
  const requestId=positiveId(value,"requestId"); const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const wfResult=await client.query("SELECT * FROM inspection_workflows WHERE service_request_id=$1 FOR UPDATE",[requestId]);
    if(!wfResult.rows.length)throw workflowError(404,"WORKFLOW_NOT_FOUND","Initialize the workflow first");
    const wf=wfResult.rows[0];
    if(wf.current_stage==="surveyor"){await client.query("COMMIT");return getInspectionWorkflow(requestId, client);}
    if(wf.current_stage!=="confirm"||!wf.selected_quotation_id)throw workflowError(409,"QUOTATION_SELECTION_REQUIRED","Select a quotation before confirmation");
    const propCheck = await client.query("SELECT * FROM commercial_proposals WHERE service_request_id = $1 AND status = 'approved'", [requestId]);
    const reqCheck = await client.query("SELECT accepted_quotation_id, accepted_expert_id FROM service_requests WHERE id = $1", [requestId]);
    const isApproved = propCheck.rows.length > 0 || (reqCheck.rows[0]?.accepted_quotation_id && reqCheck.rows[0]?.accepted_expert_id);
    if (!isApproved) {
      throw workflowError(409, "CLIENT_APPROVAL_REQUIRED", "Client commercial approval is required before assigning the Surveyor.");
    }
    await client.query("UPDATE inspection_workflows SET current_stage='surveyor',updated_at=CURRENT_TIMESTAMP WHERE id=$1",[wf.id]);
    await writeAdminAudit(client,{actorUserId,action:"inspection_workflow.surveyor_confirmed",targetType:"inspection_workflow",targetId:wf.id,summary:`Confirmed Surveyor stage for request ${requestId}`});
    await client.query("COMMIT");
    return getInspectionWorkflow(requestId);
  }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
};
