import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../src/config/db.js";
import { validateRevision, createQuotationThread, getNegotiation, submitQuotationRevision, decideQuotationRevision } from "../src/services/quotationNegotiationService.js";
import { createOrUpdateDraftProposal, sendProposalToClient } from "../src/services/commercialProposalService.js";
import { updateQuotation, deleteQuotation } from "../src/controllers/quotationController.js";
import serviceRequestRoutes from "../src/routes/serviceRequestRoutes.js";

const values={totalQuoteUsd:"1350.25",travelCost:"0.29",accommodationCost:"10.00",reportFee:"5",urgencySurcharge:"0",attendanceDays:2,coverLetter:"Revised scope"};
const response=()=>({statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}});
test("request and active proposal routes deny unauthorized roles",()=>{
  const guard=(path)=>serviceRequestRoutes.stack.find(layer=>layer.route?.path===path && layer.route.methods.get).route.stack.at(-2).handle;
  for(const path of ["/","/:id","/:id/proposal"]){
    const res=response();let next=false;
    guard(path)({user:{role_id:4}},res,()=>{next=true;});
    assert.equal(res.statusCode,403);assert.equal(next,false);
  }
  const res=response();let next=false;
  guard("/:id/proposal")({user:{role_id:2}},res,()=>{next=true;});
  assert.equal(res.statusCode,403);assert.equal(next,false);
});
test("revision money is precise and advisory maximum never rejects a higher submission",()=>{
  assert.equal(validateRevision(values).consultantTotal,"1365.54");
  assert.throws(()=>validateRevision({...values,travelCost:"0.001"}),{code:"INVALID_AMOUNT"});
  assert.throws(()=>validateRevision({...values,totalQuoteUsd:"9999999999.99"}),{code:"INVALID_AMOUNT"});
});
test("legacy quotation mutation and deletion are closed",async()=>{
  const a=response(),b=response();await updateQuotation({},a);await deleteQuotation({},b);
  assert.equal(a.statusCode,409);assert.equal(b.statusCode,409);
});
test("initial submission creates thread and immutable revision one atomically",async()=>{
  const original=pool.connect,sql=[];
  pool.connect=async()=>({release(){},async query(statement,params){sql.push({statement,params});
    if(statement.includes("FROM service_requests WHERE")) return {rows:[{id:7,status:"open",moderation_status:"approved"}]};
    if(statement.includes("FROM experts WHERE")) return {rows:[{id:3,user_id:9}]};
    if(statement.includes("SELECT id FROM quotations")) return {rows:[]};
    if(statement.includes("INSERT INTO quotations")) return {rows:[{id:5,service_request_id:7,expert_id:3,expert_user_id:9}]};
    if(statement.includes("INSERT INTO quotation_revisions")) return {rows:[{id:21,revision_number:1}]};
    return {rows:[]};}});
  try {const q=await createQuotationThread({actor:{id:9,role_id:2},body:{...values,serviceRequestId:7}});
    assert.equal(q.latest_revision_id,21);
    assert.ok(sql.some(x=>x.statement==="BEGIN"));assert.ok(sql.some(x=>x.statement==="COMMIT"));
    assert.equal(sql.find(x=>x.statement.includes("INSERT INTO quotation_revisions")).params[1],1);
  } finally {pool.connect=original;}
});
test("requested revision creates version two and preserves version one",async()=>{
  const original=pool.connect,sql=[];
  pool.connect=async()=>({release(){},async query(statement,params){sql.push({statement,params});
    if(statement.includes("SELECT service_request_id FROM quotations")) return {rows:[{service_request_id:7}]};
    if(statement.includes("FROM quotations q JOIN service_requests")) return {rows:[{id:5,service_request_id:7,expert_user_id:9,status:"pending",internal_review_status:"revision_requested",latest_revision_id:21,moderation_status:"approved",request_status:"open"}]};
    if(statement.includes("SELECT revision_number FROM quotation_revisions")) return {rows:[{revision_number:1}]};
    if(statement.includes("INSERT INTO quotation_revisions")) return {rows:[{id:22,revision_number:2}]};
    return {rows:[]};}});
  try {const revision=await submitQuotationRevision({quotationId:5,actor:{id:9,role_id:2},body:{...values,expectedRevisionId:21}});
    assert.equal(revision.revision_number,2);
    assert.equal(sql.find(x=>x.statement.includes("INSERT INTO quotation_revisions")).params[1],2);
    assert.equal(sql.some(x=>/UPDATE\s+quotation_revisions/.test(x.statement)),false);
  } finally {pool.connect=original;}
});
test("stale Consultant revision is rejected before insert",async()=>{
  const original=pool.connect;
  const sql=[];
  pool.connect=async()=>({release(){},async query(statement){sql.push(statement);
    if(statement.includes("SELECT service_request_id FROM quotations")) return {rows:[{service_request_id:7}]};
    if(statement.includes("FROM quotations q JOIN service_requests")) return {rows:[{id:5,expert_user_id:9,status:"pending",internal_review_status:"revision_requested",latest_revision_id:22,moderation_status:"approved",request_status:"open"}]};
    return {rows:[]};}});
  try {await assert.rejects(submitQuotationRevision({quotationId:5,actor:{id:9,role_id:2},body:{...values,expectedRevisionId:21}}),{code:"STALE_REVISION"});
    assert.equal(sql.some(s=>s.includes("INSERT INTO quotation_revisions")),false);
  } finally {pool.connect=original;}
});
test("wrong Consultant cannot revise another quotation",async()=>{
  const original=pool.connect;
  pool.connect=async()=>({release(){},async query(statement){
    if(statement.includes("SELECT service_request_id FROM quotations")) return {rows:[{service_request_id:7}]};
    if(statement.includes("FROM quotations q JOIN service_requests")) return {rows:[{id:5,expert_user_id:9,status:"pending",internal_review_status:"revision_requested",latest_revision_id:22}]};
    return {rows:[]};}});
  try {await assert.rejects(submitQuotationRevision({quotationId:5,actor:{id:10,role_id:2},body:{...values,expectedRevisionId:22}}),{code:"ACCESS_DENIED"});}
  finally {pool.connect=original;}
});
test("wrong Consultant cannot read another negotiation or Admin note",async()=>{
  const original=pool.query;let reads=0;
  pool.query=async(sql)=>{reads++;if(sql.includes("FROM quotations q")) return {rows:[{id:5,expert_user_id:9}]};return {rows:[]};};
  try {await assert.rejects(getNegotiation({quotationId:5,actor:{id:10,role_id:2}}),{code:"ACCESS_DENIED"});assert.equal(reads,1);}
  finally {pool.query=original;}
});
test("two Admin decisions cannot both win the same revision",async()=>{
  const original=pool.connect;
  let state="awaiting_review", inserted=0;
  pool.connect=async()=>({release(){},async query(statement){
    if(statement.includes("SELECT service_request_id FROM quotations")) return {rows:[{service_request_id:7}]};
    if(statement.includes("FROM quotations q JOIN service_requests")) return {rows:[{id:5,status:"pending",expert_user_id:null,latest_revision_id:22,internal_review_status:state,moderation_status:"approved",request_status:"open"}]};
    if(statement.includes("INSERT INTO quotation_revision_decisions")){inserted++;return {rows:[{id:31}]};}
    if(statement.includes("UPDATE quotations SET internal_review_status")) state="approved";
    return {rows:[]};}});
  try {const body={revisionId:22,decision:"approved"};await decideQuotationRevision({quotationId:5,actor:{id:1,role_id:1},body});
    await assert.rejects(decideQuotationRevision({quotationId:5,actor:{id:1,role_id:1},body}),{code:"STALE_REVISION"});
    assert.equal(inserted,1);
  } finally {pool.connect=original;}
});
test("draft and send both reject unapproved Consultant quotation",async()=>{
  const draftDb={async query(sql){
    if(sql.includes("FROM quotations q")) return {rows:[{id:5,service_request_id:7,expert_id:3,moderation_status:"approved",request_status:"open",internal_review_status:"awaiting_review",approved_revision_id:null}]};
    return {rows:[]};}};
  await assert.rejects(createOrUpdateDraftProposal({requestId:7,quotationId:5,actorUserId:1,queryable:draftDb}),{code:"QUOTATION_INTERNAL_APPROVAL_REQUIRED"});
  const sendDb={async query(sql){
    if(sql.includes("FROM service_requests WHERE")) return {rows:[{id:7,moderation_status:"approved",status:"open"}]};
    if(sql.includes("FROM commercial_proposals WHERE")) return {rows:[{id:8,quotation_id:5,expert_id:3,status:"draft",approved_quotation_revision_id:22}]};
    return {rows:[]};}};
  await assert.rejects(sendProposalToClient({requestId:7,actorUserId:1,queryable:sendDb}),{code:"QUOTATION_INTERNAL_APPROVAL_REQUIRED"});
});
