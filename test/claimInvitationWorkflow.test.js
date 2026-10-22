import test from "node:test";
import assert from "node:assert/strict";
import { issueClaimInvitation, listClaimInvitations, previewClaimInvitation, redeemClaimInvitation, revokeClaimInvitation } from "../src/services/claimInvitationService.js";

const source={source_id:"42",name:"Alex Surveyor",public_id:"FLI-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",country:"India",eligible:true};
test("invitation is disabled until mail delivery is explicitly enabled",async()=>{
  await assert.rejects(issueClaimInvitation({id:1},{targetType:"flag_inspector",targetId:"42",email:"alex@example.test"},null,null,{CLAIM_INVITATIONS_ENABLED:"false"}),{code:"INVITATIONS_DISABLED"});
});
test("email mode requires a recipient even with transport enabled",async()=>{
  await assert.rejects(issueClaimInvitation({id:1},{targetType:"flag_inspector",targetId:"42",mode:"email"},null,null,
    {CLAIM_INVITATIONS_ENABLED:"true",SMTP_HOST:"mail.example",SMTP_USER:"sender@example.test",SMTP_PASSWORD:"test"}),{code:"INVALID_EMAIL",status:400});
});
test("blank-email link uses the exact public claim page without SMTP or invitation table",async()=>{
  const companyId="11111111-1111-4111-8111-111111111111",queries=[];
  const company={id:companyId,company_name:"Harbor Works",nexaport_company_id:"NXP-0000001",public_id:"COM-"+"A".repeat(32)};
  const db={query:async(sql)=>{queries.push(sql);if(sql.includes("FROM maritime_directory_entities e"))return{rows:[company]};
    if(sql.includes("FROM public.flag_inspectors"))return{rows:[source]};return{rows:[]};}};
  const options={FRONTEND_URL:"https://nexa-port-frontend.vercel.app",CLAIM_INVITATIONS_ENABLED:"false"};
  const companyLink=await issueClaimInvitation({id:1},{targetType:"company",targetId:companyId,mode:"link"},db,null,options);
  const professionalLink=await issueClaimInvitation({id:1},{targetType:"flag_inspector",targetId:"42",mode:"link"},db,null,options);
  assert.equal(companyLink.url,`https://nexa-port-frontend.vercel.app/companies/${companyId}/claim`);
  assert.equal(professionalLink.url,"https://nexa-port-frontend.vercel.app/professionals/flag_inspector/42/claim");
  assert.equal(companyLink.status,"shareable");assert.equal(professionalLink.status,"shareable");
  assert(!queries.some(sql=>sql.includes("profile_claim_invitations")));
  assert(!JSON.stringify([companyLink,professionalLink]).includes("token"));
});
test("Admin issue stores only a token hash and sends a one-time link",async()=>{
  const calls=[];let delivered;
  const db={query:async(sql,values)=>{calls.push([sql,values]);if(sql.includes("FROM public.flag_inspectors"))return {rows:[source]};
    if(sql.includes("FROM professional_memberships"))return {rows:[]};
    if(sql.includes("INSERT INTO profile_claim_invitations"))return {rows:[{id:"11111111-1111-4111-8111-111111111111",expires_at:new Date(Date.now()+86400000)}]};return {rows:[]};}};
  const result=await issueClaimInvitation({id:1},{targetType:"flag_inspector",targetId:"42",email:"alex@example.test"},db,async payload=>{delivered=payload;},{CLAIM_INVITATIONS_ENABLED:"true",FRONTEND_URL:"https://nexaport.example",SMTP_HOST:"mail.example",SMTP_USER:"sender@example.test",SMTP_PASSWORD:"test"});
  assert.equal(result.status,"sent");
  assert.match(delivered.claimUrl,/\/claim-invitations\/[0-9a-f]{64}$/);
  const stored=calls.find(([sql])=>sql.includes("INSERT INTO profile_claim_invitations"))[1][3];
  assert.match(stored,/^[0-9a-f]{64}$/);
  assert.notEqual(stored,delivered.claimUrl.split("/").at(-1));
  assert(!JSON.stringify(result).includes(delivered.claimUrl.split("/").at(-1)));
});
test("manual invitation returns its recipient-bound URL once without using SMTP",async()=>{
  let sent=false,stored,sql=[];
  const db={query:async(statement,values)=>{sql.push(statement);if(statement.includes("FROM public.flag_inspectors"))return{rows:[source]};
    if(statement.includes("FROM professional_memberships"))return{rows:[]};
    if(statement.includes("INSERT INTO profile_claim_invitations")){stored=values;return{rows:[{id:"11111111-1111-4111-8111-111111111111",expires_at:new Date(Date.now()+86400000)}]};}
    return{rows:[]};}};
  const result=await issueClaimInvitation({id:1},{targetType:"flag_inspector",targetId:"42",email:"alex@example.test",mode:"link"},db,async()=>{sent=true;},{FRONTEND_URL:"https://nexaport.example"});
  assert.equal(result.status,"ready");assert.match(result.url,/\/claim-invitations\/[0-9a-f]{64}$/);
  assert.equal(sent,false);assert.equal(stored[2],"alex@example.test");assert.notEqual(stored[3],result.url.split("/").at(-1));
  assert(sql.some(statement=>statement.includes("profile_claim_invitation")));
});
test("Admin revocation disables an active invitation inside a transaction",async()=>{
  const sql=[];const client={query:async statement=>{sql.push(statement);return statement.includes("UPDATE profile_claim_invitations")?{rows:[{target_type:"company",target_id:"target"}]}:{rows:[]};},release(){}};
  const result=await revokeClaimInvitation("11111111-1111-4111-8111-111111111111",{id:1},{connect:async()=>client});
  assert.equal(result.status,"revoked");assert.equal(sql.at(-1),"COMMIT");
});
test("manual link works without SMTP and duplicate active recipient is rejected",async()=>{
  const db={query:async sql=>{if(sql.includes("FROM public.flag_inspectors"))return{rows:[source]};
    if(sql.includes("FROM professional_memberships"))return{rows:[]};
    if(sql.includes("INSERT INTO profile_claim_invitations"))throw Object.assign(new Error("duplicate"),{code:"23505"});return{rows:[]};}};
  await assert.rejects(issueClaimInvitation({id:1},{targetType:"flag_inspector",targetId:"42",email:"alex@example.test",mode:"link"},db,null,{FRONTEND_URL:"https://nexaport.example"}),{code:"INVITATION_EXISTS"});
});
test("a professional with an approved controller cannot be invited again",async()=>{
  const db={query:async sql=>sql.includes("FROM public.flag_inspectors")?{rows:[source]}:sql.includes("FROM professional_memberships")?{rows:[{user_id:19}]}:{rows:[]}};
  await assert.rejects(issueClaimInvitation({id:1},{targetType:"flag_inspector",targetId:"42",email:"alex@example.test",mode:"link"},db,null,{FRONTEND_URL:"https://nexaport.example"}),{code:"CONTROLLER_EXISTS"});
});
test("admin invitation history omits token hash and flags expiry",async()=>{
  const statements=[];
  const db={query:async sql=>{statements.push(sql);if(sql.includes("FROM public.flag_inspectors"))return{rows:[source]};
    return{rows:[{id:"11111111-1111-4111-8111-111111111111",recipient_email:"alex@example.test",status:"expired"}]};}};
  const rows=await listClaimInvitations({targetType:"flag_inspector",targetId:"42"},db);
  assert.equal(rows[0].status,"expired");assert(!statements.at(-1).includes("token_hash"));
});
test("email transport failure does not leave an active invitation",async()=>{
  const sql=[];const db={query:async(statement)=>{sql.push(statement);if(statement.includes("FROM public.flag_inspectors"))return{rows:[source]};
    if(statement.includes("INSERT INTO profile_claim_invitations"))return{rows:[{id:"11111111-1111-4111-8111-111111111111"}]};return{rows:[]};}};
  await assert.rejects(issueClaimInvitation({id:1},{targetType:"flag_inspector",targetId:"42",email:"alex@example.test"},db,async()=>{throw new Error("SMTP rejected");},{CLAIM_INVITATIONS_ENABLED:"true",FRONTEND_URL:"https://nexaport.example",SMTP_HOST:"mail.example",SMTP_USER:"sender@example.test",SMTP_PASSWORD:"test"}),{code:"INVITATION_DELIVERY_FAILED"});
  assert(sql.some(statement=>statement.includes("status='failed'")));
});
test("redemption verifies intended account email and locks the one-time row",async()=>{
  const token="a".repeat(64),statements=[];
  const invitation={id:"11111111-1111-4111-8111-111111111111",status:"sent",target_type:"flag_inspector",target_id:"42",recipient_email:"alex@example.test",expires_at:new Date(Date.now()+86400000)};
  const client={query:async(sql)=>{statements.push(sql);if(sql.includes("FROM profile_claim_invitations"))return {rows:[invitation]};
    if(sql.includes("FROM public.flag_inspectors"))return {rows:[source]};return {rows:[]};},release(){}};
  await assert.rejects(redeemClaimInvitation(token,{id:19,email:"other@example.test"},{connect:async()=>client}),{code:"INVITATION_RECIPIENT_MISMATCH"});
  assert.equal(statements.at(-1),"ROLLBACK");
  statements.length=0;
  const target=await redeemClaimInvitation(token,{id:19,email:"alex@example.test"},{connect:async()=>client});
  assert.equal(target.publicId,source.public_id);
  assert(statements.some(sql=>sql.includes("FOR UPDATE")));
  assert(statements.some(sql=>sql.includes("status='redeemed'")));
  assert.equal(statements.at(-1),"COMMIT");
});
test("public preview never returns recipient email or invitation secret",async()=>{
  const token="b".repeat(64);
  const db={query:async sql=>sql.includes("FROM profile_claim_invitations")?{rows:[{target_type:"flag_inspector",target_id:"42"}]}:{rows:[source]}};
  const preview=await previewClaimInvitation(token,db);
  assert.equal(preview.name,"Alex Surveyor");
  assert(!JSON.stringify(preview).includes("recipient_email"));
  assert(!JSON.stringify(preview).includes(token));
});
test("redeemed, revoked and expired invitation tokens cannot be replayed",async()=>{
  const token="c".repeat(64);
  for(const status of ["redeemed","revoked"]){
    const client={query:async sql=>sql.includes("FROM profile_claim_invitations")?{rows:[{status,recipient_email:"alex@example.test",expires_at:new Date(Date.now()+86400000)}]}:{rows:[]},release(){}};
    await assert.rejects(redeemClaimInvitation(token,{id:19,email:"alex@example.test"},{connect:async()=>client}),{code:"INVITATION_UNAVAILABLE"});
  }
  const client={query:async sql=>sql.includes("FROM profile_claim_invitations")?{rows:[{status:"ready",recipient_email:"alex@example.test",expires_at:new Date(Date.now()-1000)}]}:{rows:[]},release(){}};
  await assert.rejects(redeemClaimInvitation(token,{id:19,email:"alex@example.test"},{connect:async()=>client}),{code:"INVITATION_UNAVAILABLE"});
});
