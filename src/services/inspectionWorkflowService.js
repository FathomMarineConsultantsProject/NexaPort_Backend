import { pool } from "../config/db.js";
import { writeAdminAudit } from "./adminAuditService.js";
import { acceptQuotationOperation, calculateQuotationTotals } from "./quotationAcceptanceService.js";
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
const serviceLabelSql = `CASE WHEN sr.service_type='Other' THEN COALESCE(NULLIF(TRIM(sr.service_type_other),''),'Other') ELSE COALESCE(NULLIF(TRIM(sr.service_category),''),sr.service_type) END`;

const mapQuote = (row) => {
  if (!row) return null;
  const totals = calculateQuotationTotals(row, row.admin_markup_usd || 0);
  return {
    id: row.id, serviceRequestId: row.service_request_id, expertId: row.expert_id,
    consultantName: row.expert_name, consultantRating: row.expert_rating == null ? null : Number(row.expert_rating),
    consultantLocation: row.expert_location, status: row.status, attendanceDays: row.attendance_days,
    baseFeeUsd: Number(row.total_quote_usd || 0), travelCostUsd: Number(row.travel_cost || 0),
    accommodationCostUsd: Number(row.accommodation_cost || 0), reportFeeUsd: Number(row.report_fee || 0),
    urgencySurchargeUsd: Number(row.urgency_surcharge || 0), consultantTotalUsd: totals.consultantTotalUsd,
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
    `SELECT sr.id AS request_id,sr.title,sr.requester_name AS client_name,sr.vessel_name,
       ${serviceLabelSql} AS service,sr.port_name,sr.required_by,sr.status AS request_status,
       sr.moderation_status,sr.approved_budget_usd,sr.accepted_quotation_id,sr.accepted_expert_id,
       COALESCE(sr.accepted_expert_id,(SELECT rea.expert_id FROM request_expert_assignments rea WHERE rea.service_request_id=sr.id ORDER BY rea.updated_at DESC,rea.id DESC LIMIT 1)) AS operational_expert_id,
       aq.expert_name AS accepted_expert_name,
       COUNT(q.id) FILTER(WHERE q.status IN ('pending','submitted'))::int AS quotations_awaiting_review,
       iw.id AS workflow_id,COALESCE(iw.current_stage,CASE WHEN sr.accepted_quotation_id IS NOT NULL AND sr.accepted_expert_id IS NOT NULL THEN 'surveyor' WHEN sr.accepted_quotation_id IS NOT NULL THEN 'confirm' ELSE 'overview' END) AS current_stage,
       COALESCE(iw.updated_at,sr.updated_at) AS updated_at
     FROM service_requests sr
     LEFT JOIN inspection_workflows iw ON iw.service_request_id=sr.id
     LEFT JOIN quotations q ON q.service_request_id=sr.id
     LEFT JOIN quotations accepted_q ON accepted_q.id=sr.accepted_quotation_id
     LEFT JOIN experts aq ON aq.id=COALESCE(sr.accepted_expert_id,accepted_q.expert_id,(SELECT rea.expert_id FROM request_expert_assignments rea WHERE rea.service_request_id=sr.id ORDER BY rea.updated_at DESC,rea.id DESC LIMIT 1))
     WHERE ${conditions.join(" AND ")}
     GROUP BY sr.id,iw.id,aq.expert_name
     ORDER BY COALESCE(iw.updated_at,sr.updated_at) DESC,sr.id DESC`, values);
  return result.rows.map((row) => ({
    requestId: row.request_id, reference: row.title || `Request #${row.request_id}`, clientName: row.client_name,
    vesselName: row.vessel_name, service: row.service, portName: row.port_name, requiredBy: row.required_by,
    requestStatus: row.request_status, moderationStatus: row.moderation_status,
    approvedBudgetUsd: row.approved_budget_usd == null ? null : Number(row.approved_budget_usd),
    quotationsAwaitingReview: Number(row.quotations_awaiting_review || 0), acceptedQuotationId: row.accepted_quotation_id,
    acceptedExpert: row.operational_expert_id ? { id: row.operational_expert_id, name: row.accepted_expert_name } : null,
    workflowId: row.workflow_id, currentStage: row.current_stage, updatedAt: row.updated_at,
  }));
};

export const getInspectionWorkflow = async (requestIdValue, queryable = pool) => {
  const requestId = positiveId(requestIdValue, "requestId");
  const requestResult = await queryable.query(
    `SELECT sr.*,${serviceLabelSql} AS service_label,u.full_name AS client_user_name,u.email AS client_email,u.phone AS client_phone,
            (SELECT rea.expert_id FROM request_expert_assignments rea WHERE rea.service_request_id=sr.id ORDER BY rea.updated_at DESC,rea.id DESC LIMIT 1) AS assigned_expert_id
       FROM service_requests sr LEFT JOIN users u ON u.id=sr.requester_user_id WHERE sr.id=$1`, [requestId]);
  if (!requestResult.rows.length) throw workflowError(404,"REQUEST_NOT_FOUND","Service request not found");
  const request = requestResult.rows[0];
  if (request.moderation_status !== "approved") throw workflowError(409,"REQUEST_NOT_APPROVED","The request must finish Admin moderation before an inspection workflow can be opened.");
  const workflow = await fetchWorkflowRow(queryable, requestId);
  const quoteResult = await queryable.query(
    `SELECT q.*,e.full_name AS expert_name,e.rating AS expert_rating,e.base_location AS expert_location
       FROM quotations q LEFT JOIN experts e ON e.id=q.expert_id WHERE q.service_request_id=$1 ORDER BY q.created_at DESC`, [requestId]);
  const quotations = quoteResult.rows.map(mapQuote);
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
  const phaseTwo=workflow?await getPhaseTwoWorkflowState(requestId,queryable):{preparation:{data:{},completed:false,locked:false},templates:[],checklist:null,report:null};
  const closeout=workflow?await getInvoiceWorkflowState(requestId,queryable):{inspectionCompletion:{completed:false,completedAt:null},invoice:null};
  return {
    workflow: workflow ? { id:workflow.id,currentStage:workflow.current_stage,selectedQuotationId:workflow.selected_quotation_id,startedAt:workflow.started_at,completedAt:workflow.completed_at,createdAt:workflow.created_at,updatedAt:workflow.updated_at } : null,
    request: { id:request.id,reference:request.title||`Request #${request.id}`,title:request.title,serviceType:request.service_type,serviceCategory:request.service_category,serviceTypeOther:request.service_type_other,service:request.service_label,scope:request.scope_of_work,urgency:request.urgency,requiredBy:request.required_by,status:request.status,moderationStatus:request.moderation_status,approvedBudgetUsd:request.approved_budget_usd==null?null:Number(request.approved_budget_usd),vessel:{name:request.vessel_name,imoNumber:request.imo_number,type:request.vessel_type,flag:request.flag_state},port:{name:request.port_name,country:request.country,eta:request.eta,locationSummary:request.location_summary} },
    client: { id:request.requester_user_id,name:request.requester_name||request.client_user_name,email:request.client_email,phone:request.client_phone },
    quotations,selectedQuotation,acceptedQuotation,surveyor,
    counts:{ quotationsAwaitingReview:quotations.filter((q)=>AWAITING_QUOTATION_STATUSES.includes(String(q.status).toLowerCase())).length },
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
  try{await client.query("BEGIN"); const wf=await client.query("SELECT * FROM inspection_workflows WHERE service_request_id=$1 FOR UPDATE",[requestId]); if(!wf.rows.length)throw workflowError(404,"WORKFLOW_NOT_FOUND","Initialize the workflow first"); if(!["quote","confirm"].includes(wf.rows[0].current_stage))throw workflowError(409,"INVALID_TRANSITION","Quotation selection is only available during Quote or Confirm"); const quote=await client.query("SELECT id,status FROM quotations WHERE id=$1 AND service_request_id=$2",[quotationId,requestId]); if(!quote.rows.length)throw workflowError(409,"QUOTATION_REQUEST_MISMATCH","Quotation does not belong to this request"); if(!AWAITING_QUOTATION_STATUSES.includes(String(quote.rows[0].status).toLowerCase()))throw workflowError(409,"QUOTATION_NOT_ELIGIBLE","Quotation is no longer eligible for selection"); await client.query("UPDATE inspection_workflows SET selected_quotation_id=$1,current_stage='confirm',updated_at=CURRENT_TIMESTAMP WHERE id=$2",[quotationId,wf.rows[0].id]); await writeAdminAudit(client,{actorUserId,action:"inspection_workflow.quotation_selected",targetType:"inspection_workflow",targetId:wf.rows[0].id,summary:`Selected quotation ${quotationId} for request ${requestId}`}); await client.query("COMMIT"); return getInspectionWorkflow(requestId);}catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
};

export const confirmWorkflowQuotation = async ({requestId:value,adminMarkupUsd,actorUserId}) => {
  const requestId=positiveId(value,"requestId"); const client=await pool.connect();
  try{await client.query("BEGIN"); const wfResult=await client.query("SELECT * FROM inspection_workflows WHERE service_request_id=$1 FOR UPDATE",[requestId]); if(!wfResult.rows.length)throw workflowError(404,"WORKFLOW_NOT_FOUND","Initialize the workflow first"); const wf=wfResult.rows[0]; if(wf.current_stage==="surveyor"){await client.query("COMMIT");return getInspectionWorkflow(requestId);} if(wf.current_stage!=="confirm"||!wf.selected_quotation_id)throw workflowError(409,"QUOTATION_SELECTION_REQUIRED","Select a quotation before confirmation"); const accepted=await acceptQuotationOperation({queryable:client,quotationId:wf.selected_quotation_id,adminMarkupUsd,actorUserId}); if(Number(accepted.serviceRequestId)!==requestId)throw workflowError(409,"QUOTATION_REQUEST_MISMATCH","Selected quotation does not belong to this request"); await client.query("UPDATE inspection_workflows SET current_stage='surveyor',updated_at=CURRENT_TIMESTAMP WHERE id=$1",[wf.id]); await writeAdminAudit(client,{actorUserId,action:"inspection_workflow.quotation_confirmed",targetType:"inspection_workflow",targetId:wf.id,summary:`Confirmed quotation ${wf.selected_quotation_id} for request ${requestId}`}); await writeAdminAudit(client,{actorUserId,action:"inspection_workflow.surveyor_confirmed",targetType:"inspection_workflow",targetId:wf.id,summary:`Assigned Consultant ${accepted.expertId} to request ${requestId}`}); await client.query("COMMIT"); return getInspectionWorkflow(requestId);}catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
};
