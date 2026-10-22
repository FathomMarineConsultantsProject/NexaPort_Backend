import test from "node:test";
import assert from "node:assert/strict";
import { getPublicCompany,searchCompanies } from "../src/services/companyClaimService.js";

const uuid="11111111-1111-4111-8111-111111111111";
const legacy=`COM-${"A".repeat(32)}`;
const company={id:uuid,public_id:legacy,nexaport_company_id:"NXP-0000001",company_name:"Test Marine",directory_types:["ship_agent","supplier"]};
test("short, legacy and UUID company references resolve to one canonical record",async()=>{
  const calls=[];const db={query:async(sql,values)=>{calls.push([sql,values]);return{rows:[company]};}};
  for(const ref of ["NXP-0000001",legacy,uuid]){
    const result=await getPublicCompany(ref,db);
    assert.equal(result.id,uuid);assert.equal(result.nexaport_company_id,"NXP-0000001");
  }
  assert.match(calls[0][0],/e\.nexaport_company_id=\$1/);
  assert.match(calls[1][0],/e\.public_id=\$1/);
  assert.match(calls[2][0],/e\.id=\$1/);
});
test("public company search keeps name and legacy lookup alongside short IDs",async()=>{
  let statement;
  const db={query:async sql=>{statement=sql;return{rows:[company]};}};
  const result=await searchCompanies({q:"NXP-0000001"},db);
  assert.equal(result.data[0].nexaport_company_id,"NXP-0000001");
  assert.match(statement,/e\.nexaport_company_id=upper\(\$1\)/);
  assert.match(statement,/e\.public_id=upper\(\$1\)/);
  assert.match(statement,/e\.company_name ILIKE/);
});
