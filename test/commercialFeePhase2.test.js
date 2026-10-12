import assert from "node:assert/strict";
import test from "node:test";
import { calculateProposalFinancials, createOrUpdateDraftProposal, sendProposalToClient, mapProposalRow } from "../src/services/commercialProposalService.js";
import { createProposalSentNotification } from "../src/services/adminNotificationService.js";
import { decideQuotationRevision } from "../src/services/quotationNegotiationService.js";
import { pool } from "../src/config/db.js";

const quote = { total_quote_usd: "2000.00", travel_cost: "0.00", accommodation_cost: "150.00", report_fee: "100.00", urgency_surcharge: "0.00" };

test("percentage fee uses all approved expenses with exact cent rounding", () => {
  const standard = calculateProposalFinancials(quote, 0, "percentage", "25");
  assert.equal(standard.consultantTotalUsd, 2250);
  assert.equal(standard.adminMarkupUsd, 562.5);
  assert.equal(standard.clientTotalUsd, 2812.5);
  const changed = calculateProposalFinancials(quote, 0, "percentage", "20");
  assert.equal(changed.adminMarkupUsd, 450);
  assert.equal(changed.clientTotalUsd, 2700);
  const rounding = calculateProposalFinancials({total_quote_usd:"0.02"}, 0, "percentage", "25");
  assert.equal(rounding.adminMarkupUsd, 0.01);
  assert.equal(rounding.clientTotalUsd, 0.03);
  const hiddenUrgency = calculateProposalFinancials({...quote,urgency_surcharge:"500.00"}, "500.00", "custom");
  assert.equal(hiddenUrgency.clientTotalUsd,3250);
});

test("custom fee preserves fixed amount and rejects invalid money", () => {
  const result = calculateProposalFinancials(quote, "500.00", "custom");
  assert.equal(result.consultantTotalUsd, 2250);
  assert.equal(result.adminMarkupUsd, 500);
  assert.equal(result.clientTotalUsd, 2750);
  assert.throws(() => calculateProposalFinancials(quote, "NaN"), {code:"INVALID_AMOUNT"});
  assert.throws(() => calculateProposalFinancials(quote, "-1"), {code:"INVALID_AMOUNT"});
  assert.throws(() => calculateProposalFinancials(quote, "0.001"), {code:"INVALID_AMOUNT"});
});

test("unchanged saved draft retains its historical fixed fee without rewrite or notification", async () => {
  const statements=[];
  const saved={id:101,service_request_id:7,quotation_id:50,expert_id:12,revision_number:1,
    approved_quotation_revision_id:201,consultant_total_usd:2250,admin_markup_usd:500,client_total_usd:2750,
    fee_mode:"custom",fee_percentage:null,client_notes:null,internal_admin_notes:null,estimated_attendance_days:2,status:"draft"};
  const queryable={async query(sql){statements.push(sql);
    if(sql.includes("FROM quotations q")) return {rows:[{id:50,expert_id:12,moderation_status:"approved",request_status:"open",internal_review_status:"approved",latest_revision_id:201,approved_revision_id:201}]};
    if(sql.includes("FROM quotation_revisions r")) return {rows:[{id:201,base_fee:"2000.00",travel_cost:"0",accommodation_cost:"150",report_fee:"100",urgency_surcharge:"0",consultant_total:"2250.00",attendance_days:2}]};
    if(sql.includes("status = 'draft' FOR UPDATE")) return {rows:[saved]};
    if(sql.includes("FROM commercial_proposals cp")) return {rows:[saved]};
    return {rows:[]};
  }};
  const result=await createOrUpdateDraftProposal({requestId:7,quotationId:50,actorUserId:1,queryable});
  assert.equal(result.admin_markup_usd,500);
  assert.equal(result.client_total_usd,2750);
  assert.equal(statements.some(sql=>/UPDATE commercial_proposals|INSERT INTO public.admin_notifications|INSERT INTO admin_audit/i.test(sql)),false);
});

test("new draft defaults to 25 percent on immutable approved revision, not mutable thread amount", async () => {
  let insertValues;
  const created={id:202,service_request_id:7,quotation_id:50,expert_id:12,revision_number:1,
    consultant_total_usd:2250,admin_markup_usd:562.5,client_total_usd:2812.5,fee_mode:"percentage",fee_percentage:25,status:"draft"};
  const queryable={async query(sql,values){
    if(sql.includes("FROM quotations q")) return {rows:[{id:50,expert_id:12,total_quote_usd:"9000",moderation_status:"approved",request_status:"open",internal_review_status:"approved",latest_revision_id:201,approved_revision_id:201}]};
    if(sql.includes("FROM quotation_revisions r")) return {rows:[{id:201,base_fee:"2000",travel_cost:"0",accommodation_cost:"150",report_fee:"100",urgency_surcharge:"0",consultant_total:"2250",attendance_days:2}]};
    if(sql.includes("status = 'draft' FOR UPDATE")) return {rows:[]};
    if(sql.includes("MAX(revision_number)")) return {rows:[{max_rev:0}]};
    if(sql.includes("INSERT INTO commercial_proposals")){insertValues=values;return {rows:[created]};}
    if(sql.includes("FROM commercial_proposals cp")) return {rows:[created]};
    return {rows:[]};
  }};
  await createOrUpdateDraftProposal({requestId:7,quotationId:50,actorUserId:1,queryable});
  assert.equal(insertValues[4],2000);
  assert.equal(insertValues[6],2250);
  assert.equal(insertValues[7],562.5);
  assert.equal(insertValues[8],2812.5);
  assert.equal(insertValues[14],"percentage");
  assert.equal(insertValues[15],25);
});

test("sent retry and failed approval gate do not emit another Client notification", async () => {
  for(const status of ["sent","draft"]){
    const statements=[];
    const queryable={async query(sql){statements.push(sql);
      if(sql.includes("FROM service_requests WHERE")) return {rows:[{id:7,requester_user_id:30,moderation_status:"approved",status:"open"}]};
      if(sql.includes("FROM commercial_proposals WHERE")) return {rows:[{id:101,service_request_id:7,quotation_id:50,expert_id:12,status,approved_quotation_revision_id:201}]};
      if(sql.includes("FROM commercial_proposals cp")) return {rows:[{id:101,status}]};
      return {rows:[]};
    }};
    if(status==="sent") await sendProposalToClient({requestId:7,proposalId:101,actorUserId:1,queryable});
    else await assert.rejects(sendProposalToClient({requestId:7,proposalId:101,actorUserId:1,queryable}),{code:"QUOTATION_INTERNAL_APPROVAL_REQUIRED"});
    assert.equal(statements.some(sql=>sql.includes("admin_notifications")),false);
  }
});

test("proposal notification dedupe follows proposal identity and stays Client-only", async () => {
  const calls=[];
  const queryable={async query(sql,params){calls.push({sql,params});return {rowCount:1};}};
  for(const proposalId of [101,101,102]) await createProposalSentNotification(queryable,{requestId:7,proposalId,recipientUserId:30,revisionNumber:proposalId===102?2:1,clientTotalUsd:2750});
  assert.deepEqual(calls.map(call=>call.params[1]),["101","101","102"]);
  assert.ok(calls.every(call=>call.params[0]===30 && /ON CONFLICT/.test(call.sql)));
  assert.equal(mapProposalRow({id:101,client_total_usd:"2750",admin_markup_usd:"500",fee_mode:"percentage",fee_percentage:"25"},{role_id:2}),null);
  const client=mapProposalRow({id:101,client_total_usd:"2750",admin_markup_usd:"500",fee_mode:"percentage",fee_percentage:"25"},{role_id:3});
  assert.equal(client.adminMarkupUsd,undefined);
  assert.equal(client.feePercentage,undefined);
});

test("Admin negotiation notification targets owning Consultant without internal notes or Client price", async () => {
  const original=pool.connect;let notification;
  pool.connect=async()=>({release(){},async query(sql,params){
    if(sql.includes("SELECT service_request_id FROM quotations")) return {rows:[{service_request_id:7}]};
    if(sql.includes("FROM quotations q JOIN service_requests")) return {rows:[{id:50,service_request_id:7,expert_user_id:40,status:"pending",latest_revision_id:201,internal_review_status:"awaiting_review",moderation_status:"approved",request_status:"open"}]};
    if(sql.includes("INSERT INTO quotation_revision_decisions")) return {rows:[{id:300}]};
    if(sql.includes("INSERT INTO public.admin_notifications")) notification=params;
    return {rows:[]};
  }});
  try {await decideQuotationRevision({quotationId:50,actor:{id:1,role_id:1},body:{revisionId:201,decision:"revision_requested",consultantMessage:"Please revise",internalAdminNote:"Private margin discussion",suggestedMaxAmount:"1200",suggestedMaxCurrency:"USD"}});
    assert.equal(notification[0],40);
    assert.equal(notification[2],"300");
    assert.equal(notification.join(" ").includes("Private margin discussion"),false);
    assert.equal(notification.join(" ").includes("client_total"),false);
  } finally {pool.connect=original;}
});
