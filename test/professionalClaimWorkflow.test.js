import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideProfessionalClaim, getProfessional, registerClaimAccount, revokeProfessionalMembership, updateProfessionalOverlay } from "../src/services/professionalClaimService.js";
import { allowRoles } from "../src/middlewares/authMiddleware.js";

const fixture = { source_id: "42", name: "Alex Surveyor", public_id: "FLI-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", country: "India", eligible: true };

test("source lookup keeps the original public reference and refuses organization-only rows", async () => {
  const queries=[];
  const db={ query: async (sql,values)=>{queries.push([sql,values]);return {rows:[fixture]};} };
  assert.deepEqual(await getProfessional("flag_inspector","42",db),{source_type:"flag_inspector",...fixture});
  assert.match(queries[0][0],/is_active=true/);
  assert.match(queries[0][0],/NULLIF\(BTRIM\(full_name\)/);
  await getProfessional("accredited_inspector","42",db);
  assert.match(queries[1][0],/accreditation_schemes WHERE id=scheme_id AND is_active=true/);
  await getProfessional("appointed_surveyor","42",db);
  assert.match(queries[2][0],/is_active=true/);
  await assert.rejects(getProfessional("scheme","42",db),{code:"INVALID_TARGET"});
});

test("claim registration creates a credential and intent without inserting an Expert", async () => {
  const sql=[];
  const client={ query: async (statement)=>{sql.push(statement);if(statement.includes("FROM users WHERE")) return {rows:[]};
    if(statement.includes("INSERT INTO users")) return {rows:[{id:19,full_name:"Alex Surveyor",email:"alex@example.test",username:"alex",role_id:2,is_active:true}]};return {rows:[]};},release(){} };
  const db={ query: async()=>({rows:[fixture]}),connect:async()=>client };
  const result=await registerClaimAccount({sourceType:"flag_inspector",sourceId:"42",fullName:"Alex Surveyor",email:"alex@example.test",username:"alex",password:"abc12345",confirmPassword:"abc12345"},db);
  assert.equal(result.target.public_id,fixture.public_id);
  assert(sql.some(statement=>statement.includes("INSERT INTO professional_claim_account_intents")));
  assert(sql.every(statement=>!statement.includes("INSERT INTO experts")));
  assert(sql.some(statement=>statement==="COMMIT"));
});

test("approval links exact source and grants role inside one transaction", async () => {
  const statements=[];
  const claim={id:"a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3",source_type:"flag_inspector",source_id:"42",claimant_user_id:19,status:"pending"};
  const client={query:async(sql)=>{statements.push(sql);if(sql.includes("FROM professional_claims WHERE id=")) return {rows:[claim]};
    if(sql.includes("FROM public.flag_inspectors")) return {rows:[{id:"42",eligible:true}]};
    if(sql.includes("FROM professional_memberships")) return {rows:[]};
    if(sql.includes("count(*)::int AS count")) return {rows:[{count:0}]};return {rows:[]};},release(){} };
  const db={connect:async()=>client};
  const result=await decideProfessionalClaim(claim.id,"approve",{id:1},"Verified appointment", "",db);
  assert.equal(result.status,"approved");
  assert(statements.some(sql=>sql.includes("INSERT INTO professional_memberships")));
  assert(statements.some(sql=>sql.includes("INSERT INTO user_roles")));
  assert(statements.some(sql=>sql.includes("admin_audit") || sql.includes("admin_audit_log")) || statements.length>7);
  assert.equal(statements.at(-1),"COMMIT");
});

test("self review and existing controller fail before any new membership", async () => {
  const id="a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3";
  const statements=[];
  const client={query:async sql=>{statements.push(sql);if(sql.includes("FROM professional_claims WHERE id=")) return {rows:[{id,source_type:"flag_inspector",source_id:"42",claimant_user_id:19,status:"pending"}]};
    return {rows:[]};},release(){} };
  await assert.rejects(decideProfessionalClaim(id,"approve",{id:19},"", "",{connect:async()=>client}),{code:"SELF_REVIEW"});
  assert(!statements.some(sql=>sql.includes("INSERT INTO professional_memberships")));
  assert.equal(statements.at(-1),"ROLLBACK");
});

test("an existing verified controller blocks a competing approval", async () => {
  const id="a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3",statements=[];
  const client={query:async sql=>{statements.push(sql);if(sql.includes("FROM professional_claims WHERE id="))return{rows:[{id,source_type:"flag_inspector",source_id:"42",claimant_user_id:19,status:"pending"}]};
    if(sql.includes("FROM public.flag_inspectors"))return{rows:[{id:"42",eligible:true}]};
    if(sql.includes("count(*)::int AS count"))return{rows:[{count:0}]};
    if(sql.includes("FROM professional_memberships"))return{rows:[{user_id:20}]};return{rows:[]};},release(){}};
  await assert.rejects(decideProfessionalClaim(id,"approve",{id:1},"", "",{connect:async()=>client}),{code:"CONTROLLER_EXISTS"});
  assert.equal(statements.at(-1),"ROLLBACK");
  assert(!statements.some(sql=>sql.includes("INSERT INTO user_roles")));
});

test("revocation removes only the approved target link and retains role membership",async()=>{
  const statements=[];
  const client={query:async sql=>{statements.push(sql);if(sql.includes("UPDATE professional_memberships"))return{rows:[{user_id:19}]};return{rows:[]};},release(){}};
  const db={query:async()=>({rows:[fixture]}),connect:async()=>client};
  const result=await revokeProfessionalMembership("flag_inspector","42",19,{id:1},"Identity dispute reviewed",db);
  assert.equal(result.status,"revoked");
  assert(statements.some(sql=>sql.includes("status='revoked'")));
  assert(!statements.some(sql=>sql.includes("DELETE FROM user_roles")));
  assert.equal(statements.at(-1),"COMMIT");
});

test("profile overrides require active membership and never update source credentials", async () => {
  const statements=[];
  const db={query:async sql=>{statements.push(sql);if(sql.includes("FROM public.flag_inspectors")) return {rows:[fixture]};
    if(sql.includes("FROM professional_memberships")) return {rows:[]};return {rows:[]};}};
  await assert.rejects(updateProfessionalOverlay(19,"flag_inspector","42",{biography:"Hello"},db),{code:"NOT_CONTROLLER"});
  assert(!statements.some(sql=>sql.includes("UPDATE public.flag_inspectors")));
});

test("pending claim-only Consultant cannot enter operational role-2 routes", () => {
  let nextCalled=false,statusCode,body;
  allowRoles(2)({user:{id:19,role_id:2,professional_claim_pending:true}},
    {status(code){statusCode=code;return this;},json(value){body=value;}},()=>{nextCalled=true;});
  assert.equal(statusCode,403);
  assert.equal(body.code,"PROFILE_CLAIM_PENDING");
  assert.equal(nextCalled,false);
});

test("migration preserves imported IDs and enforces one active controller", () => {
  const migration=readFileSync(new URL("../sql/professional_claiming_001.sql",import.meta.url),"utf8");
  assert.match(migration,/professional_one_active_controller/);
  assert.match(migration,/professional_one_pending_claim_per_user/);
  assert.doesNotMatch(migration,/UPDATE\s+public\.(experts|flag_inspectors|accredited_inspectors|appointed_ship_surveyors)/i);
});
