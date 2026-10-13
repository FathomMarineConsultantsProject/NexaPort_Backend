import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../src/config/db.js";
import { resolveSelectedRequestPorts, persistSelectedRequestPorts, requestPortCollection, guardPrimaryPortScheduleChange } from "../src/services/requestPortsService.js";
import { createServiceRequest, updateServiceRequest } from "../src/controllers/serviceRequestController.js";
const response = () => ({ statusCode: 200, status(n) { this.statusCode=n; return this; }, json(body) { this.body=body; } });
const ports = [{ id: 1, port_name: "Chennai", country: "India", unlocode: "INMAA" }, { id: 2, port_name: "Chennai", country: "Other", unlocode: "XXABC" }];

test("canonical collections distinguish same-named ports and validate primary, duplicates and inactive IDs", async () => {
  const db = { query: async () => ({ rows: ports }) };
  const selected = await resolveSelectedRequestPorts(db, { portIds: [1,2], primaryPortId: 2 });
  assert.equal(selected.ports.length,2); assert.equal(selected.primary.id,2);
  for (const body of [{ portIds:[1,1] },{ portIds:[1], primaryPortId:2 },{ portIds:["bad"] }])
    await assert.rejects(resolveSelectedRequestPorts(db,body), (e)=>e.status===400);
  await assert.rejects(resolveSelectedRequestPorts({ query:async()=>({rows:[ports[0]]}) },{portIds:[1,2]}), /inactive/);
  assert.equal((await resolveSelectedRequestPorts(db,{portIds:[]})).primary,null);
});

test("primary schedule stays attached unless the change is explicitly confirmed", () => {
  const old={port_id:1,terminal_name:"Terminal",eta:"2026-10-20"};
  assert.doesNotThrow(()=>guardPrimaryPortScheduleChange(old,1,{}));
  assert.throws(()=>guardPrimaryPortScheduleChange(old,2,{}), /Confirm/);
  assert.doesNotThrow(()=>guardPrimaryPortScheduleChange(old,2,{confirmPrimaryPortChange:true}));
  assert.equal(requestPortCollection({port_id:1,port_name:"Historical",country:"India"})[0].port_name,"Historical");
  assert.deepEqual(requestPortCollection({port_name:"Unresolved legacy text"}),[]);
});

test("create persists primary snapshots and ordered relationships in the same transaction", async () => {
  const previous=pool.connect; const calls=[]; let stored;
  pool.connect=async()=>({ release(){}, async query(sql,values=[]) {
    calls.push(sql);
    if(sql.includes("SELECT id,port_name,country,unlocode")) return {rows:ports};
    if(sql.includes("INSERT INTO service_requests")) {
      const columns=sql.match(/INSERT INTO service_requests\s*\(([\s\S]*?)\)\s*VALUES/)[1].split(",").map((s)=>s.trim());
      stored=Object.fromEntries(columns.map((s,i)=>[s,values[i]])); return {rows:[{id:9,...stored}]};
    }
    return {rows:[]};
  }});
  try {
    const res=response(); await createServiceRequest({user:{id:3,role_id:3},body:{serviceType:"Audit",serviceCategory:"ISM",title:"Test",scopeOfWork:"Scope",portIds:[1,2],primaryPortId:2,terminalName:"New Terminal",eta:"2026-10-20"}},res);
    assert.equal(res.statusCode,201); assert.equal(stored.port_id,2); assert.equal(stored.port_name,"Chennai");
    assert.equal(stored.terminal_name,"New Terminal"); assert.equal(res.body.data.ports.length,2);
    assert.equal(calls.filter((s)=>s.includes("INSERT INTO service_request_ports")).length,2);
    assert.equal(calls.at(-1),"COMMIT");
  } finally {pool.connect=previous;}
});

test("relationship write failure rolls back create instead of committing a partial request", async () => {
  const previous=pool.connect; const calls=[];
  pool.connect=async()=>({release(){},async query(sql) {
    calls.push(sql); if(sql.includes("SELECT id,port_name,country,unlocode"))return {rows:[ports[0]]};
    if(sql.includes("INSERT INTO service_requests"))return {rows:[{id:9}]};
    if(sql.includes("INSERT INTO service_request_ports"))throw new Error("Simulated relation failure");
    return {rows:[]};
  }});
  const originalError=console.error; console.error=()=>{};
  try {const res=response();await createServiceRequest({user:{id:3,role_id:3},body:{serviceType:"Audit",serviceCategory:"ISM",title:"Test",scopeOfWork:"Scope",portIds:[1]}},res);
    assert.equal(res.statusCode,500);assert.equal(calls.at(-1),"ROLLBACK");assert.ok(!calls.includes("COMMIT"));
  } finally {pool.connect=previous;console.error=originalError;}
});

test("explicitly unconfirmed primary-port changes cannot update request snapshots or relationships", async () => {
  const previous=pool.connect; const calls=[];
  pool.connect=async()=>({release(){},async query(sql) {
    calls.push(sql);
    if(sql.includes("FOR UPDATE OF sr"))return {rows:[{id:9,requester_user_id:3,status:"open",moderation_status:"pending",port_id:1,terminal_name:"Old",eta:"2026-10-20"}]};
    if(sql.includes("SELECT id,port_name,country,unlocode"))return {rows:[ports[1]]};
    return {rows:[]};
  }});
  try {const res=response();await updateServiceRequest({params:{id:9},user:{id:3,role_id:3},body:{portIds:[2],primaryPortId:2}},res);
    assert.equal(res.statusCode,400);assert.equal(calls.at(-1),"ROLLBACK");assert.ok(!calls.some((s)=>s.startsWith("UPDATE service_requests")));
  } finally {pool.connect=previous;}
});

test("relationship replacement preserves explicit primary and position values", async () => {
  const rows=[];await persistSelectedRequestPorts({query:async(sql,values)=>{rows.push({sql,values});return{rows:[]};}},9,[{id:2,isPrimary:true},{id:1,isPrimary:false}]);
  assert.deepEqual(rows[1].values,[9,2,0,true]);assert.deepEqual(rows[2].values,[9,1,1,false]);
});

test("metadata edits keep primary Terminal/ETA; confirmed changes clear omitted old schedule fields", async () => {
  const previous=pool.connect;
  try {for(const changed of [false,true]) {
    let update;const calls=[];
    pool.connect=async()=>({release(){},async query(sql,values=[]) {
      calls.push(sql);
      if(sql.includes("FOR UPDATE OF sr"))return{rows:[{id:9,requester_user_id:3,status:"open",moderation_status:"pending",port_id:1,terminal_name:"Old Terminal",eta:"2026-10-20",selected_ports:[{...ports[0],isPrimary:true}]}]};
      if(sql.includes("SELECT id,port_name,country,unlocode"))return{rows:changed?[ports[1]]:[ports[0]]};
      if(sql.startsWith("UPDATE service_requests")){update={sql,values};return{rows:[{id:9,port_id:changed?2:1}]};}
      return{rows:[]};
    }});
    const res=response();await updateServiceRequest({params:{id:9},user:{id:3,role_id:3},body:{portIds:[changed?2:1],primaryPortId:changed?2:1,...(changed?{confirmPrimaryPortChange:true}:{})}},res);
    assert.equal(res.statusCode,200);assert.equal(res.body.data.ports[0].id,changed?2:1);
    if(changed){assert.match(update.sql,/terminal_name =/);assert.match(update.sql,/eta =/);assert.ok(update.values.includes(null));}
    else {assert.doesNotMatch(update.sql,/terminal_name =|eta =/);}
    assert.equal(calls.at(-1),"COMMIT");
  }}finally{pool.connect=previous;}
});
