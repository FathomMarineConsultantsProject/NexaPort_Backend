import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { inferInitialStage, AWAITING_QUOTATION_STATUSES, requireApprovedWorkflowRequest, WORKFLOW_STAGES } from "../src/services/inspectionWorkflowService.js";
import { calculateQuotationTotals } from "../src/services/quotationAcceptanceService.js";
import { allowRoles } from "../src/middlewares/authMiddleware.js";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("workflow exposes the complete validated 13-stage sequence", () => {
  assert.equal(WORKFLOW_STAGES.length, 13);
  assert.deepEqual(WORKFLOW_STAGES.slice(0, 4), ["overview", "quote", "confirm", "surveyor"]);
  assert.equal(WORKFLOW_STAGES.at(-1), "invoice_paid");
});

test("existing accepted assignment data reconciles to the earliest sensible stage", () => {
  assert.equal(inferInitialStage({}), "overview");
  assert.equal(inferInitialStage({ accepted_quotation_id: 4 }), "confirm");
  assert.equal(inferInitialStage({ accepted_quotation_id: 4, accepted_expert_id: 8 }), "surveyor");
  assert.equal(inferInitialStage({ status:"assigned", assigned_expert_id:8 }), "surveyor");
});

test("awaiting review count statuses exclude accepted and rejected", () => {
  assert.deepEqual(AWAITING_QUOTATION_STATUSES, ["pending", "submitted"]);
  assert.equal(AWAITING_QUOTATION_STATUSES.includes("accepted"), false);
  assert.equal(AWAITING_QUOTATION_STATUSES.includes("rejected"), false);
});

test("shared quotation calculation preserves existing fee breakdown", () => {
  assert.deepEqual(calculateQuotationTotals({ total_quote_usd: 1000, travel_cost: 100, accommodation_cost: 50, report_fee: 75, urgency_surcharge: 25 }, 200), { consultantTotalUsd: 1250, markupUsd: 200, clientTotalUsd: 1450 });
});

test("workflow routes are authenticated and Super Admin-only", async () => {
  const routes = await source("../src/routes/inspectionWorkflowRoutes.js");
  assert.match(routes, /router\.use\(requireAuth,allowRoles\(1\)\)/);
  assert.match(routes, /router\.post\("\/:requestId\/confirm"/);
});

test("workflow role enforcement admits Admin and rejects Consultant, Client, and Provider", () => {
  const guard = allowRoles(1);
  const run = (roleId) => { let nextCalled=false; let responseStatus=null; guard({user:{role_id:roleId}},{status(code){responseStatus=code;return this;},json(){return this;}},()=>{nextCalled=true;}); return {nextCalled,responseStatus}; };
  assert.deepEqual(run(1), { nextCalled:true, responseStatus:null });
  for (const roleId of [2,3,4]) assert.deepEqual(run(roleId), { nextCalled:false, responseStatus:403 });
});

test("initialization eligibility blocks pending and rejected requests", () => {
  assert.equal(requireApprovedWorkflowRequest({ moderation_status:"approved" }).moderation_status, "approved");
  for (const moderation_status of ["pending","rejected"]) assert.throws(() => requireApprovedWorkflowRequest({ moderation_status }), (error) => error.status === 409 && error.code === "REQUEST_NOT_APPROVED");
});

test("queue and transitions enforce approved requests, ownership, and transactions", async () => {
  const service = await source("../src/services/inspectionWorkflowService.js");
  assert.match(service, /sr\.moderation_status='approved'/);
  assert.match(service, /requireApprovedWorkflowRequest\(request\)/);
  assert.match(service, /service_request_id=\$2/);
  assert.match(service, /await client\.query\("BEGIN"\)/);
  assert.match(service, /acceptQuotationOperation/);
  assert.match(service, /current_stage='surveyor'/);
  assert.ok(service.indexOf("acceptQuotationOperation") < service.lastIndexOf("current_stage='surveyor'"));
  assert.match(service, /if\(!workflow\)/);
});

test("migration creates one workflow per request with stage validation and only required indexes", async () => {
  const migration = await readFile(new URL("../sql/inspection_workflows_001.sql", import.meta.url), "utf8");
  assert.match(migration, /service_request_id INTEGER NOT NULL UNIQUE/);
  assert.match(migration, /inspection_workflows_stage_check/);
  assert.match(migration, /preparation_data JSONB NOT NULL/);
  assert.match(migration, /inspection_workflows_service_request_id_idx/);
  assert.match(migration, /inspection_workflows_current_stage_idx/);
  assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS public\.(invoice|payment)/i);
});
