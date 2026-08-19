import { pool } from "../config/db.js";
import { calculateQuotationTotals } from "./quotationAcceptanceService.js";

const numberOrNull = (value) => value == null ? null : Number(value);

export const assembleInspectionReportDataset = async (requestId, queryable = pool) => {
  const result = await queryable.query(
    `SELECT sr.*,iw.id AS workflow_id,iw.current_stage,iw.preparation_data,iw.preparation_updated_at,iw.report_id,
            u.full_name AS client_user_name,u.email AS client_email,u.phone AS client_phone,
            q.id AS quote_id,q.total_quote_usd,q.travel_cost,q.accommodation_cost,q.report_fee,q.urgency_surcharge,q.admin_markup_usd,q.client_total_usd,q.status AS quote_status,
            e.id AS surveyor_id,e.full_name AS surveyor_name,e.biography AS surveyor_biography,e.base_location AS surveyor_location,e.country AS surveyor_country,e.years_experience,e.rating AS surveyor_rating,
            r.template_id,r.template_version_id,r.values_jsonb,r.status AS report_status,r.generated_pdf_s3_key,r.generated_at,r.updated_at AS report_updated_at,r.confirmed_at,r.confirmed_by_user_id,r.final_pdf_s3_key,
            t.title AS template_title,t.description AS template_description,t.template_scope,t.status AS template_status,
            tv.version_number,tv.fields_jsonb,tv.layout_jsonb
       FROM service_requests sr
       JOIN inspection_workflows iw ON iw.service_request_id=sr.id
       LEFT JOIN users u ON u.id=sr.requester_user_id
       LEFT JOIN quotations q ON q.id=sr.accepted_quotation_id
       LEFT JOIN experts e ON e.id=COALESCE(sr.accepted_expert_id,q.expert_id,(SELECT rea.expert_id FROM request_expert_assignments rea WHERE rea.service_request_id=sr.id ORDER BY rea.updated_at DESC,rea.id DESC LIMIT 1))
       LEFT JOIN inspection_reports r ON r.id=iw.report_id
       LEFT JOIN inspection_templates t ON t.id=r.template_id
       LEFT JOIN inspection_template_versions tv ON tv.id=r.template_version_id
      WHERE sr.id=$1`, [requestId]);
  if (!result.rows[0]) throw Object.assign(new Error("Inspection workflow not found"), { status:404, code:"WORKFLOW_NOT_FOUND" });
  const row=result.rows[0];
  const evidenceResult=row.report_id ? await queryable.query("SELECT id,field_key,photo_s3_key,caption,sort_order,uploaded_at FROM inspection_report_photos WHERE report_id=$1 ORDER BY field_key,sort_order,id",[row.report_id]) : {rows:[]};
  const quote=row.quote_id ? calculateQuotationTotals(row,row.admin_markup_usd) : null;
  return {
    request:{id:row.id,reference:row.title,title:row.title,serviceType:row.service_type,serviceCategory:row.service_category,serviceTypeOther:row.service_type_other,scope:row.scope_of_work,urgency:row.urgency,requiredBy:row.required_by,status:row.status,moderationStatus:row.moderation_status,approvedBudgetUsd:numberOrNull(row.approved_budget_usd),port:{name:row.port_name,country:row.country,eta:row.eta,locationSummary:row.location_summary}},
    client:{id:row.requester_user_id,name:row.requester_name||row.client_user_name,email:row.client_email,phone:row.client_phone},
    vessel:{name:row.vessel_name,imoNumber:row.imo_number,type:row.vessel_type,flag:row.flag_state},
    surveyor:row.surveyor_id?{id:row.surveyor_id,name:row.surveyor_name,biography:row.surveyor_biography,location:[row.surveyor_location,row.surveyor_country].filter(Boolean).join(", "),yearsExperience:row.years_experience,rating:numberOrNull(row.surveyor_rating)}:null,
    commercial:{approvedRequestBudgetUsd:numberOrNull(row.approved_budget_usd),acceptedQuotation:row.quote_id?{id:row.quote_id,status:row.quote_status,baseFeeUsd:Number(row.total_quote_usd||0),travelCostUsd:Number(row.travel_cost||0),accommodationCostUsd:Number(row.accommodation_cost||0),reportFeeUsd:Number(row.report_fee||0),urgencySurchargeUsd:Number(row.urgency_surcharge||0),consultantTotalUsd:quote.consultantTotalUsd,adminMarkupUsd:quote.markupUsd,clientTotalUsd:Number(row.client_total_usd||quote.clientTotalUsd)}:null},
    preparation:row.preparation_data||{},
    checklist:row.report_id?{reportId:row.report_id,template:{id:row.template_id,title:row.template_title,description:row.template_description,scope:row.template_scope,status:row.template_status},version:{id:row.template_version_id,number:row.version_number,fields:row.fields_jsonb||[],layout:row.layout_jsonb||{}},values:row.values_jsonb||{}}:null,
    evidence:evidenceResult.rows.map((item)=>({id:item.id,fieldKey:item.field_key,objectKey:item.photo_s3_key,caption:item.caption,sortOrder:item.sort_order,uploadedAt:item.uploaded_at})),
    report:row.report_id?{id:row.report_id,status:row.report_status,generatedAt:row.generated_at,updatedAt:row.report_updated_at,generatedObjectKey:row.generated_pdf_s3_key,confirmedAt:row.confirmed_at,confirmedByUserId:row.confirmed_by_user_id,finalObjectKey:row.final_pdf_s3_key}:null,
    workflow:{id:row.workflow_id,currentStage:row.current_stage,reportId:row.report_id,preparationUpdatedAt:row.preparation_updated_at},
  };
};
