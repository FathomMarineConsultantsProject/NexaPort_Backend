import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { pool } from "../src/config/db.js";
import { createOrUpdateDraftProposal, sendProposalToClient, approveProposalByClient, rejectProposalByClient, mapProposalRow } from "../src/services/commercialProposalService.js";
import { decideQuotationRevision, submitQuotationRevision, getNegotiation } from "../src/services/quotationNegotiationService.js";
import { getServiceRequestEditPermission } from "../src/services/serviceRequestEditPermission.js";

const fixture = ({ accepted = false, invoice = false, completed = false } = {}) => {
  const request={id:7,requester_user_id:30,moderation_status:"approved",status:accepted?"active":"pending_client_approval",active_proposal_id:100,accepted_quotation_id:accepted?50:null,accepted_expert_id:accepted?12:null,budget_usd:accepted?2500:3000};
  const quote={id:50,service_request_id:7,expert_id:12,expert_user_id:40,status:accepted?"accepted":"submitted",internal_review_status:"approved",latest_revision_id:201,approved_revision_id:201,total_quote_usd:2000};
  const revision={id:201,quotation_id:50,revision_number:1,base_fee:2000,currency:"USD",travel_cost:0,accommodation_cost:0,report_fee:0,urgency_surcharge:0,consultant_total:2000};
  const original={id:100,service_request_id:7,quotation_id:50,expert_id:12,revision_number:1,approved_quotation_revision_id:201,status:accepted?"approved":"sent",consultant_total_usd:2000,client_total_usd:2500,admin_markup_usd:500,fee_mode:"percentage",fee_percentage:25,sent_at:"2026-10-01",decided_at:accepted?"2026-10-02":null,decided_by_user_id:accepted?30:null};
  const proposals=[original],revisions=[revision],decisions=[{id:1,revision_id:201,decision:"approved"}],reopens=[],calls=[],notifications=new Set();
  const workflow={id:9,current_stage:"review",completed_at:completed?"2026-10-03":null};
  let authorized=true;
  const query=async(sql,values=[])=>{
    calls.push({sql,values});
    if (["BEGIN","COMMIT","ROLLBACK"].includes(sql)) return {rows:[]};
    if (sql.includes("sr.active_proposal_id=cp.id")) return {rows:proposals.filter(p=>p.id===request.active_proposal_id&&p.status==="approved").map(p=>({...p,request_status:request.status}))};
    if (sql.includes("FROM inspection_workflows") && !sql.startsWith("UPDATE")) return {rows:[workflow]};
    if (sql.includes("FROM inspection_invoices")) return {rows:invoice?[{id:88}]:[]};
    if (sql.startsWith("SELECT id FROM service_requests") || sql.startsWith("SELECT * FROM service_requests")) return {rows:[request]};
    if (sql.includes("SELECT service_request_id FROM quotations")) return {rows:[{service_request_id:7}]};
    if (sql.includes("FROM quotations q")) return {rows:[{...quote,moderation_status:request.moderation_status,request_status:request.status,revision_id:authorized?quote.approved_revision_id:null}]};
    if (sql.includes("FROM quotation_reopen_requests")) return {rows:reopens};
    if (sql.includes("FROM quotation_revisions r")) {
      if (sql.includes("ORDER BY r.revision_number")) return {rows:revisions.map(r=>{const d=decisions.find(d=>d.revision_id===r.id);return {...r,decision:d?.decision,decision_id:d?.id};})};
      return {rows:authorized?revisions.filter(r=>r.id===Number(values[0])):[]};
    }
    if (sql.includes("SELECT revision_number FROM quotation_revisions")) return {rows:revisions.filter(r=>r.id===Number(values[0]))};
    if (sql.includes("INSERT INTO quotation_revisions")) {
      const r={id:202+revisions.length-1,quotation_id:values[0],revision_number:values[1],base_fee:values[4],travel_cost:values[6],accommodation_cost:values[7],report_fee:values[8],urgency_surcharge:values[9],consultant_total:values[10]};revisions.push(r);return {rows:[r]};
    }
    if (sql.includes("INSERT INTO quotation_reopen_requests")) {
      const r={id:reopens.length+1,revision_id:values[0],actor_user_id:values[1],reason:values[2],consultant_message:values[3],suggested_max_amount:values[4],suggested_max_currency:values[5],internal_admin_note:values[6]}; reopens.push(r);return {rows:[r]};
    }
    if (sql.includes("INSERT INTO quotation_revision_decisions")) {const d={id:decisions.length+1,revision_id:values[0],decision:values[1]};decisions.push(d);return {rows:[d]};}
    if (sql.includes("UPDATE quotations") && sql.includes("status = 'accepted'")) quote.status="accepted";
    if (sql.startsWith("UPDATE quotations SET internal_review_status")) {quote.internal_review_status=values[0];quote.approved_revision_id=values[1];}
    if (sql.startsWith("UPDATE quotations SET latest_revision_id")) {quote.latest_revision_id=values[0];quote.internal_review_status="awaiting_review";quote.approved_revision_id=null;}
    if (sql.includes("FROM commercial_proposals cp") && sql.includes("FOR UPDATE OF cp, sr")) {
      const p=proposals.find(p=>p.id===Number(values[0]));return {rows:p?[{...p,requester_user_id:30,active_proposal_id:request.active_proposal_id,moderation_status:"approved",expert_user_id:40}]:[]};
    }
    if (sql.includes("FROM commercial_proposals cp")) return {rows:proposals.filter(p=>p.id===Number(values[0]))};
    if (sql.includes("MAX(revision_number)")) return {rows:[{max_rev:Math.max(...proposals.map(p=>p.revision_number))}]};
    if (sql.includes("FROM commercial_proposals WHERE")) {
      return {rows:sql.includes("status = 'draft'")?proposals.filter(p=>p.status==="draft"):proposals.filter(p=>p.id===Number(values[0]))};
    }
    if (sql.includes("INSERT INTO commercial_proposals")) {
      const p={id:100+proposals.length,service_request_id:values[0],quotation_id:values[1],expert_id:values[2],revision_number:values[3],consultant_base_quote_usd:values[4],consultant_expenses_usd:values[5],consultant_total_usd:values[6],admin_markup_usd:values[7],client_total_usd:values[8],client_notes:values[9],internal_admin_notes:values[10],approved_quotation_revision_id:values[13],fee_mode:values[14],fee_percentage:values[15],amends_proposal_id:values[16],status:"draft"};proposals.push(p);return {rows:[p]};
    }
    if (sql.includes("UPDATE commercial_proposals")) {
      if (sql.includes("AND status = 'sent'")) {for(const p of proposals) if(p.status==="sent"&&p.id!==Number(values[1]))p.status="superseded";return {rows:[]};}
      const status=sql.includes("status = 'sent'")?"sent":sql.includes("status = 'approved'")?"approved":sql.includes("status = 'rejected'")?"rejected":null;
      const p=proposals.find(p=>p.id===Number(values.at(-1)));
      if(status&&p){p.status=status;if(status==="approved"){p.decided_by_user_id=values[0];p.decided_at="2026-10-05";}return {rows:[p]};}
    }
    if (sql.includes("UPDATE service_requests") && sql.includes("status = 'assigned'")) {request.accepted_quotation_id=values[0];request.accepted_expert_id=values[1];request.active_proposal_id=values[2];request.budget_usd=values[3];request.status="assigned";}
    if (sql.includes("UPDATE service_requests SET active_proposal_id=$1")) {request.active_proposal_id=values[0];request.budget_usd=values[1];}
    if (sql.includes("UPDATE service_requests")&&sql.includes("pending_client_approval")) {request.active_proposal_id=values[0];request.status="pending_client_approval";}
    if (sql.includes("admin_notifications")) notifications.add(JSON.stringify(values));
    return {rows:[],rowCount:1};
  };
  const db={query,release(){}};
  let tail=Promise.resolve();
  const run=(operation)=>{const next=tail.then(()=>operation(db));tail=next.catch(()=>{});return next;};
  return {request,quote,workflow,original,proposals,revisions,decisions,reopens,calls,notifications,db,run,setAuthorized(value){authorized=value;}};
};
const draft=(f,parent=null)=>createOrUpdateDraftProposal({requestId:7,quotationId:50,amendsProposalId:parent,feeMode:"custom",adminMarkupUsd:300,actorUserId:1,queryable:f.db});
const send=(f,id=101)=>sendProposalToClient({requestId:7,proposalId:id,actorUserId:1,queryable:f.db});
const accept=(f,id=101,actorUserId=30)=>approveProposalByClient({proposalId:id,actorUserId,queryable:f.db});

test("sent revision preserves snapshot, supersedes prior sent offer, and emits one Client notice per offer",async()=>{
  const f=fixture(),before=structuredClone(f.original);
  const p=await draft(f);assert.equal(p.revision_number,2);assert.equal(p.client_total_usd,2300);
  assert.deepEqual(f.original,before);
  await send(f);assert.equal(f.original.status,"superseded");assert.equal(f.original.client_total_usd,2500);
  assert.equal(f.request.active_proposal_id,101);assert.equal(f.request.status,"pending_client_approval");
  const notices=f.notifications.size;await send(f);assert.equal(f.notifications.size,notices);
  await assert.rejects(accept(f,100),{code:"PROPOSAL_SUPERSEDED"});
  assert.ok(f.calls.find(c=>c.sql.includes("commercial_proposal_sent")&&c.values[0]===30));
});

test("Client approval winning the draft race requires explicit amendment before another send",async()=>{
  const f=fixture();await draft(f);f.original.status="approved";f.original.decided_at="2026-10-04";f.original.decided_by_user_id=30;f.request.status="assigned";
  const before=structuredClone(f.original);await assert.rejects(send(f),{code:"CREATE_AMENDMENT_REQUIRED"});
  assert.deepEqual(f.original,before);assert.equal(f.request.active_proposal_id,100);
  assert.ok(!f.calls.some(c=>c.sql.includes("SET status = 'superseded'")));
});

test("amendment draft and send preserve approval, operational status, accepted price and assignment",async()=>{
  const f=fixture({accepted:true}),before=structuredClone(f.original);
  await assert.rejects(draft(f),{code:"CREATE_AMENDMENT_REQUIRED"});
  const p=await draft(f,100);assert.equal(p.amends_proposal_id,100);await send(f);
  assert.deepEqual(f.original,before);assert.equal(f.request.budget_usd,2500);assert.equal(f.request.active_proposal_id,100);assert.equal(f.request.status,"active");assert.equal(f.workflow.current_stage,"review");
  assert.ok(!f.calls.some(c=>c.sql.includes("INSERT INTO request_expert_assignments")));
});

test("amendment acceptance adopts new terms without replacing original history or replaying assignments/stages",async()=>{
  const f=fixture({accepted:true}),before=structuredClone(f.original);await draft(f,100);await send(f);
  await Promise.all([f.run(()=>accept(f)),f.run(()=>accept(f))]);
  assert.deepEqual(f.original,before);assert.equal(f.request.budget_usd,2300);assert.equal(f.request.active_proposal_id,101);assert.equal(f.request.status,"active");assert.equal(f.workflow.current_stage,"review");
  assert.ok(!f.calls.some(c=>/INSERT INTO request_expert_assignments|UPDATE inspection_workflows|status = 'assigned'/.test(c.sql)));
  assert.equal(f.calls.filter(c=>c.values.includes("commercial_proposal.amendment_approved")).length,1);
});

test("declining an amendment leaves the last approved agreement authoritative",async()=>{
  const f=fixture({accepted:true});await draft(f,100);await send(f);
  await rejectProposalByClient({proposalId:101,rejectionReason:"Keep original terms",actorUserId:30,queryable:f.db});
  assert.equal(f.proposals[1].status,"rejected");assert.equal(f.request.active_proposal_id,100);assert.equal(f.request.budget_usd,2500);assert.equal(f.request.status,"active");
  assert.ok(!f.calls.some(c=>c.sql.includes("SET status = 'open'")));
});

test("invoice, completed workflow and stale amendment parent block draft/send/accept without financial writes",async()=>{
  for(const options of [{invoice:true},{completed:true}]){
    const f=fixture({accepted:true,...options});await assert.rejects(draft(f,100),{code:"FINANCIAL_ADJUSTMENT_REQUIRED"});assert.equal(f.proposals.length,1);
  }
  const f=fixture({accepted:true});await assert.rejects(draft(f,99),{code:"STALE_AMENDMENT"});
  await draft(f,100);f.workflow.completed_at="2026-10-05";await assert.rejects(send(f),{code:"FINANCIAL_ADJUSTMENT_REQUIRED"});
  f.proposals[1].status="sent";await assert.rejects(accept(f),{code:"FINANCIAL_ADJUSTMENT_REQUIRED"});assert.equal(f.request.budget_usd,2500);
});

test("send requires latest internal approval; Client cannot approve another owner's amendment",async()=>{
  const f=fixture({accepted:true});await draft(f,100);f.quote.internal_review_status="awaiting_review";await assert.rejects(send(f),{code:"QUOTATION_INTERNAL_APPROVAL_REQUIRED"});
  f.quote.internal_review_status="approved";await send(f);await assert.rejects(accept(f,101,31),{code:"NOT_REQUEST_OWNER"});
  const client=mapProposalRow(f.proposals[1],{role_id:3});assert.equal(client.amendsProposalId,100);assert.equal(client.clientTotalUsd,2300);
  for(const key of ["adminMarkupUsd","consultantTotalUsd","internalAdminNotes","feePercentage"]) assert.equal(client[key],undefined);
  assert.equal(mapProposalRow(f.proposals[1],{role_id:2}),null);
});

test("reopening approved negotiation retains original decision; successive submissions require fresh review and retain accepted cost",async()=>{
  const f=fixture({accepted:true}),originalConnect=pool.connect,originalQuery=pool.query;
  pool.connect=async()=>f.db;pool.query=f.db.query;
  try {
    const before=structuredClone(f.decisions[0]);
    const body={decision:"revision_requested",revisionId:201,consultantMessage:"Review travel",internalAdminNote:"Private",suggestedMaxAmount:1800,suggestedMaxCurrency:"USD"};
    await decideQuotationRevision({quotationId:50,actor:{id:1,role_id:1},body});
    assert.equal(f.quote.internal_review_status,"revision_requested");assert.equal(f.quote.approved_revision_id,null);assert.deepEqual(f.decisions[0],before);
    await assert.rejects(decideQuotationRevision({quotationId:50,actor:{id:1,role_id:1},body}),{code:"STALE_REVISION"});
    const consultant=await getNegotiation({quotationId:50,actor:{id:40,role_id:2}});assert.equal(consultant.reopenRequests[0].internalAdminNote,undefined);assert.equal(consultant.reopenRequests[0].consultantMessage,"Review travel");
    await submitQuotationRevision({quotationId:50,actor:{id:40,role_id:2},body:{expectedRevisionId:201,totalQuoteUsd:1900}});
    assert.equal(f.quote.total_quote_usd,2000);assert.equal(f.quote.internal_review_status,"awaiting_review");assert.equal(f.quote.latest_revision_id,202);
    await assert.rejects(draft(f,100),{code:"QUOTATION_INTERNAL_APPROVAL_REQUIRED"});
    await decideQuotationRevision({quotationId:50,actor:{id:1,role_id:1},body:{decision:"approved",revisionId:202}});
    await decideQuotationRevision({quotationId:50,actor:{id:1,role_id:1},body:{...body,revisionId:202}});
    await submitQuotationRevision({quotationId:50,actor:{id:40,role_id:2},body:{expectedRevisionId:202,totalQuoteUsd:1850}});
    assert.deepEqual(f.revisions.map(r=>r.revision_number),[1,2,3]);assert.equal(f.original.approved_quotation_revision_id,201);assert.equal(f.quote.total_quote_usd,2000);
    assert.equal(f.reopens.length,2);assert.deepEqual(f.decisions[0],before);
  } finally {pool.connect=originalConnect;pool.query=originalQuery;}
});

test("negotiation decisions reject non-Admins and material request edits remain locked",async()=>{
  for(const role_id of [2,3,4])await assert.rejects(decideQuotationRevision({quotationId:50,actor:{id:40,role_id},body:{}}),{code:"ACCESS_DENIED"});
  assert.equal(getServiceRequestEditPermission({request:{status:"pending_client_approval",moderation_status:"approved"},roleId:1,userId:1}).allowed,false);
  assert.equal(getServiceRequestEditPermission({request:{accepted_quotation_id:50},roleId:1,userId:1}).allowed,false);
});

test("migration protects immutable approved decisions and sent snapshots without new lifecycle statuses",async()=>{
  const sql=await readFile(new URL("../sql/commercial_amendments_004.sql",import.meta.url),"utf8");
  assert.match(sql,/quotation_reopen_requests_immutable/);assert.match(sql,/commercial_snapshot_immutable/);assert.match(sql,/OLD.status IN \('approved','rejected','superseded'\)/);assert.match(sql,/IS DISTINCT FROM/);
  assert.doesNotMatch(sql,/UPDATE public.quotation_revision_decisions|ALTER.*status/);
});

test("competing send and Client acceptance serialize on the request; either winner preserves a consistent agreement",async()=>{
  const acceptedFirst=fixture();await draft(acceptedFirst);
  const first=await Promise.allSettled([acceptedFirst.run(()=>accept(acceptedFirst,100)),acceptedFirst.run(()=>send(acceptedFirst))]);
  assert.equal(first[0].status,"fulfilled");assert.equal(first[1].reason.code,"CREATE_AMENDMENT_REQUIRED");assert.equal(acceptedFirst.request.active_proposal_id,100);assert.equal(acceptedFirst.original.status,"approved");
  const sentFirst=fixture();await draft(sentFirst);
  const second=await Promise.allSettled([sentFirst.run(()=>send(sentFirst)),sentFirst.run(()=>accept(sentFirst,100))]);
  assert.equal(second[0].status,"fulfilled");assert.equal(second[1].reason.code,"PROPOSAL_SUPERSEDED");assert.equal(sentFirst.request.active_proposal_id,101);
});

test("paid workflow and changing the assigned Consultant block commercial amendments",async()=>{
  const f=fixture({accepted:true});f.workflow.current_stage="invoice_paid";
  await assert.rejects(draft(f,100),{code:"FINANCIAL_ADJUSTMENT_REQUIRED"});
  f.workflow.current_stage="review";f.quote.expert_id=13;
  await assert.rejects(draft(f,100),{code:"STALE_AMENDMENT"});assert.equal(f.proposals.length,1);
});
