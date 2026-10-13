import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../src/config/db.js";
import { clientQuotationPrice } from "../src/services/clientQuotationPrice.js";
import { getQuotations } from "../src/controllers/quotationController.js";
import { getServiceRequestById } from "../src/controllers/serviceRequestController.js";
const response=()=>({status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}});

test("unavailable Client totals never fall back to Consultant purchase cost",()=>{
  assert.equal(clientQuotationPrice({total_quote_usd:2000}),null);
  assert.equal(clientQuotationPrice({client_total_usd:2500,total_quote_usd:2000}),2500);
  assert.equal(clientQuotationPrice({authorized_client_total_usd:2500,total_quote_usd:2000}),2500);
  assert.equal(clientQuotationPrice({client_total_usd:0,total_quote_usd:2000}),0);
});

test("Client quotation API preserves final-only confidentiality and owning accepted-row predicates",async()=>{
  const previous=pool.query;let sql;
  pool.query=async(text)=>{sql=text;return{rows:[{id:5,status:"accepted",total_quote_usd:2000,admin_markup_usd:500,client_total_usd:null,cover_letter:"Private",expert_user_id:2}]};};
  try {const res=response();await getQuotations({query:{serviceRequestId:9},user:{id:3,role_id:3}},res);
    const q=res.body.data[0];assert.equal(q.finalTotalUsd,null);assert.equal(q.totalQuoteUsd,null);
    for(const field of ["adminMarkupUsd","travelCost","coverLetter","internalStatus"])assert.equal(q[field],undefined);
    assert.match(sql,/sr.requester_user_id =/);assert.match(sql,/q.status = 'accepted'/);
    assert.match(sql,/cp.status='approved'/);
  }finally{pool.query=previous;}
});

test("Client detail excludes internal adjustment fields while Admin retains financial detail",async()=>{
  const previous=pool.query;
  pool.query=async(sql)=>{
    if(sql.includes("FROM service_requests sr"))return{rows:[{id:9,requester_user_id:3,status:"assigned",accepted_quotation_id:5,admin_budget_adjustment_type:"fixed",admin_budget_adjustment_mode:"markup",admin_budget_adjustment_value:500}]};
    if(sql.includes("FROM quotations q"))return{rows:[{id:5,status:"accepted",total_quote_usd:2000,admin_markup_usd:500,client_total_usd:null}]};
    return{rows:[]};
  };
  try {const client=response();await getServiceRequestById({params:{id:9},user:{id:3,role_id:3}},client);
    assert.equal(client.body.data.quotations[0].finalTotalUsd,null);
    for(const field of ["adminBudgetAdjustmentType","adminBudgetAdjustmentMode","adminBudgetAdjustmentValue"])assert.equal(client.body.data[field],undefined);
    const admin=response();await getServiceRequestById({params:{id:9},user:{id:1,role_id:1}},admin);
    assert.equal(admin.body.data.quotations[0].adminMarkupUsd,500);assert.equal(admin.body.data.adminBudgetAdjustmentValue,500);
  }finally{pool.query=previous;}
});
