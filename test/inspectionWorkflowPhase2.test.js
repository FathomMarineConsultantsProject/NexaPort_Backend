import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isDraftFresh, validatePreparationCompletion } from "../src/services/inspectionWorkflowPhase2Service.js";
import { FIELD_TYPES, missingRequiredFields, validateReportValues } from "../src/services/templateFieldService.js";

const source=(path)=>readFile(new URL(path,import.meta.url),"utf8");

test("preparation completion requires Master identity and one contact route",()=>{
  assert.equal(validatePreparationCompletion({master:{name:"Master Lee",phone:"+1",email:""},shipEmail:""}).length,0);
  assert.deepEqual(validatePreparationCompletion({master:{name:"",phone:"",email:""},shipEmail:""}).map((item)=>item.field),["master.name","master.contact"]);
});

test("existing template field types drive checklist execution and Yes/No is constrained",()=>{
  assert.deepEqual(FIELD_TYPES,["text","textarea","number","date","checkbox","yes_no","select","signature","photo","section_heading","system_identity"]);
  const fields=[{fieldKey:"safe",label:"Safe for entry",type:"yes_no",required:true},{fieldKey:"note",label:"Note",type:"text",required:false}];
  assert.deepEqual(validateReportValues(fields,{safe:"Yes",note:"Observed"}),{safe:"Yes",note:"Observed"});
  assert.throws(()=>validateReportValues(fields,{safe:"Maybe"}),/Yes or No/);
  assert.deepEqual(missingRequiredFields(fields,{safe:""}),["Safe for entry"]);
});

test("draft freshness detects preparation and checklist edits and accepts regeneration",()=>{
  const generated="2026-08-19T10:00:00.000Z";
  assert.equal(isDraftFresh({preparation_updated_at:"2026-08-19T09:00:00.000Z"},{generated_pdf_s3_key:"key",generated_at:generated,updated_at:generated}),true);
  assert.equal(isDraftFresh({preparation_updated_at:"2026-08-19T11:00:00.000Z"},{generated_pdf_s3_key:"key",generated_at:generated,updated_at:generated}),false);
  assert.equal(isDraftFresh({preparation_updated_at:"2026-08-19T09:00:00.000Z"},{generated_pdf_s3_key:"key",generated_at:generated,updated_at:"2026-08-19T11:00:00.000Z"}),false);
  assert.equal(isDraftFresh({},{confirmed_at:generated,final_pdf_s3_key:"final"}),true);
});

test("Phase 2 orchestration reuses reports, evidence, PDF generation, and transactional transitions",async()=>{
  const service=await source("../src/services/inspectionWorkflowPhase2Service.js");
  assert.match(service,/inspection_reports/);
  assert.match(service,/inspection_report_photos/);
  assert.match(service,/validateReportValues/);
  assert.match(service,/missingRequiredFields/);
  assert.match(service,/generateReportPdf/);
  assert.match(service,/writePrivateObject/);
  assert.match(service,/current_stage='report'/);
  assert.match(service,/current_stage='review'/);
  assert.match(service,/current_stage='report_confirmation'/);
  assert.doesNotMatch(service,/service_requests SET status='completed'/);
});

test("normalized report dataset keeps approved budget and all authoritative domains",async()=>{
  const dataset=await source("../src/services/inspectionReportDataService.js");
  for(const domain of ["request","client","vessel","surveyor","commercial","preparation","checklist","evidence","report","workflow"])assert.match(dataset,new RegExp(`${domain}:`));
  assert.match(dataset,/approved_budget_usd/);
  assert.doesNotMatch(dataset,/client_budget_usd/);
});

test("workflow report access excludes Consultant ownership and raw final object keys",async()=>{
  const controller=await source("../src/controllers/reportController.js");
  assert.match(controller,/!report\.workflow_id/);
  assert.match(controller,/iw\.id IS NULL/);
  assert.match(controller,/final_pdf_s3_key, \.\.\.row/);
});

test("Phase 2 migration extends existing tables without creating another report model",async()=>{
  const migration=await source("../sql/inspection_workflows_002_report_finalization.sql");
  assert.match(migration,/ALTER TABLE public\.inspection_workflows/);
  assert.match(migration,/ALTER TABLE public\.inspection_reports/);
  assert.match(migration,/generated_at/);
  assert.match(migration,/confirmed_by_user_id/);
  assert.doesNotMatch(migration,/CREATE TABLE/);
});

test("all Phase 2 routes inherit Super Admin-only workflow middleware",async()=>{
  const routes=await source("../src/routes/inspectionWorkflowRoutes.js");
  assert.match(routes,/router\.use\(requireAuth,allowRoles\(1\)\)/);
  for(const route of ["preparation/complete","checklist/template","checklist/complete","evidence/upload-url","report/generate","report/review","report/confirm"])assert.match(routes,new RegExp(route.replace("/","\\/")));
});
