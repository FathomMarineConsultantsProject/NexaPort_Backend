import test from "node:test";
import assert from "node:assert/strict";
import { listAdminProfileClaims } from "../src/services/adminProfileClaimsService.js";

test("unified queue uses server-side status counts and bounded pagination",async()=>{
  const queries=[];
  const db={query:async(sql,values)=>{queries.push([sql,values]);return sql.includes("SELECT * FROM filtered")
    ? {rows:[{id:"claim-1",claim_type:"company",target_name:"Test Company",reference:"NXP-0000001"}]}
    : {rows:[{total:1,pending:2,approved:3,rejected:4,disputed:1}]};}};
  const result=await listAdminProfileClaims({type:"company",status:"approved",q:"test",page:2},db);
  assert.equal(result.summary.approved,3);assert.equal(result.page,2);assert.equal(result.limit,25);
  assert.deepEqual(queries[1][1],["company","approved","test",25,25]);
  assert.match(queries[0][0],/FROM scoped/);
  assert.match(queries[1][0],/ORDER BY created_at DESC,id DESC LIMIT/);
  assert.match(queries[1][0],/e\.nexaport_company_id AS reference/);
  await assert.rejects(listAdminProfileClaims({type:"users"},db),{code:"INVALID_FILTER"});
});
