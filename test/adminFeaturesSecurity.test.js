import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { allowRoles } from "../src/middlewares/authMiddleware.js";
import { deleteServiceRequestById } from "../src/services/serviceRequestService.js";

const source = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("application entrypoint imports with every expert route export present", async () => {
  await assert.doesNotReject(import("../src/app.js"));
});

test("role guard rejects non-Super Admins and admits role 1", () => {
  const guard = allowRoles(1);
  let nextCalled = false;
  const denied = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  guard({ user: { role_id: 2 } }, denied, () => { nextCalled = true; });
  assert.equal(denied.statusCode, 403);
  assert.equal(nextCalled, false);

  guard({ user: { role_id: 1 } }, denied, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("service-request mutation roles admit Super Admins and Clients but reject Experts", () => {
  const guard = allowRoles(1, 3);
  const run = (roleId) => {
    let admitted = false;
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json() { return this; } };
    guard({ user: { role_id: roleId } }, response, () => { admitted = true; });
    return { admitted, statusCode: response.statusCode };
  };

  assert.deepEqual(run(1), { admitted: true, statusCode: 200 });
  assert.deepEqual(run(3), { admitted: true, statusCode: 200 });
  assert.deepEqual(run(2), { admitted: false, statusCode: 403 });
});

test("notification endpoints are Super Admin-only and recipient scoped", async () => {
  const [routes, controller] = await Promise.all([
    source("src/routes/adminNotificationRoutes.js"),
    source("src/controllers/adminNotificationController.js"),
  ]);

  assert.match(routes, /router\.use\(requireAuth, allowRoles\(1\)\)/);
  assert.match(routes, /patch\("\/read-all"/);
  assert.match(routes, /patch\("\/:id\/read"/);
  assert.match(controller, /WHERE recipient_user_id = \$1/);
  assert.match(controller, /WHERE id = \$1 AND recipient_user_id = \$2/);
  assert.doesNotMatch(controller, /recipient_user_id\s*=\s*req\.(body|query)/);
});

test("registration notifications target active role-1 users and de-duplicate", async () => {
  const [service, clientController, consultantController] = await Promise.all([
    source("src/services/adminNotificationService.js"),
    source("src/controllers/clientRegistrationController.js"),
    source("src/controllers/consultantRegistrationController.js"),
  ]);

  assert.match(service, /FROM public\.users u/);
  assert.match(service, /u\.role_id = 1/);
  assert.match(service, /u\.is_active = TRUE/);
  assert.match(service, /ON CONFLICT \(recipient_user_id, type, entity_type, entity_id\)/);
  assert.match(service, /DO NOTHING/);
  assert.match(clientController, /type: "client_registration"/);
  assert.match(clientController, /entityId: profile\.id/);
  assert.match(consultantController, /type: "consultant_registration"/);
  assert.match(consultantController, /entityId: expert\.id/);
});

test("bulk deletion is absent and individual deletion is role protected", async () => {
  const [routes, controller, service] = await Promise.all([
    source("src/routes/serviceRequestRoutes.js"),
    source("src/controllers/serviceRequestController.js"),
    source("src/services/serviceRequestService.js"),
  ]);

  assert.doesNotMatch(routes, /delete\("\/all"/);
  assert.doesNotMatch(controller, /deleteAllServiceRequests/);
  assert.match(routes, /delete\("\/:id", requireAuth, requireApprovedClient, allowRoles\(1, 3\), deleteServiceRequest\)/);
  assert.match(controller, /await client\.query\("BEGIN"\)/);
  assert.match(controller, /FOR UPDATE/);
  assert.match(controller, /await client\.query\("COMMIT"\)/);
  assert.match(controller, /await client\.query\("ROLLBACK"\)/);
  assert.match(controller, /requester_user_id/);
  assert.match(service, /WHERE id = \$1/);
  assert.match(service, /DELETE FROM public\.service_requests WHERE id = \$1 RETURNING id/);
});

test("request creation is limited to roles 1 and 3 and uses the authenticated user", async () => {
  const [routes, controller] = await Promise.all([
    source("src/routes/serviceRequestRoutes.js"),
    source("src/controllers/serviceRequestController.js"),
  ]);

  assert.match(routes, /post\("\/", requireAuth, requireApprovedClient, allowRoles\(1, 3\), createServiceRequest\)/);
  assert.match(controller, /requester_user_id[\s\S]*req\.user\.id/);
  assert.doesNotMatch(controller, /requester_user_id\s*}\s*=\s*req\.body/);
});

test("service-request deletion blocks business dependencies and targets only the selected request", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("SELECT COUNT(*)::int")) return { rows: [{ quotations: 0, assignments: 0 }] };
      return { rowCount: 1, rows: [{ id: 42 }] };
    },
  };

  const result = await deleteServiceRequestById(client, 42);
  assert.equal(result.deleted, true);
  assert.deepEqual(calls[0].params, [42]);
  assert.deepEqual(calls[1].params, [42]);
  assert.match(calls[1].sql, /DELETE FROM public\.service_requests WHERE id = \$1 RETURNING id/);
});

test("request moderation is explicit and Consultant responses are allowlisted", async () => {
  const controller = await source("src/controllers/serviceRequestController.js");
  const routes = await source("src/routes/serviceRequestRoutes.js");
  assert.match(controller, /moderation_status[\s\S]*"pending"[\s\S]*"open"/);
  assert.match(controller, /sr\.moderation_status = 'approved'/);
  assert.match(controller, /serializeApprovedServiceRequestForConsultant/);
  assert.match(controller, /inspectionType: row\.inspection_type/);
  assert.doesNotMatch(controller.match(/const serializeApprovedServiceRequestForConsultant[\s\S]*?\}\);/)[0], /title|imo|budget|requester|vesselName/);
  assert.match(routes, /post\("\/:id\/approve", requireAuth, allowRoles\(1\), approveServiceRequest\)/);
});

test("approval notifications target active primary and membership Consultants with safe payload", async () => {
  const service = await source("src/services/adminNotificationService.js");
  assert.match(service, /FROM public\.user_roles ur WHERE ur\.user_id = u\.id AND ur\.role_id = 2/);
  assert.doesNotMatch(service, /JOIN public\.experts/);
  assert.match(service, /u\.role_id = 2/);
  assert.match(service, /u\.is_active = TRUE/);
  assert.match(service, /service_request_approved/);
  assert.doesNotMatch(service, /vessel_name|imo_number|requester_name|client_name/);
});

test("personal notifications and administration APIs are authenticated and role-scoped", async () => {
  const [notifications, administration] = await Promise.all([
    source("src/routes/notificationRoutes.js"),
    source("src/routes/adminAdministrationRoutes.js"),
  ]);
  assert.match(notifications, /router\.use\(requireAuth, allowRoles\(1, 2\)\)/);
  assert.match(administration, /router\.use\(requireAuth, allowRoles\(1\)\)/);
  assert.match(administration, /deletion-impact/);
  assert.match(administration, /deactivate-anonymize/);
});

test("available request moderation migration preserves existing budget and operational status", async () => {
  const moderation = await source("sql/service_request_moderation_001.sql");
  assert.match(moderation, /ADD COLUMN IF NOT EXISTS client_budget_usd/);
  assert.match(moderation, /WHERE client_budget_usd IS NULL/);
  assert.match(moderation, /approved_budget_usd = budget_usd/);
  assert.doesNotMatch(moderation, /DROP TABLE|DROP COLUMN/);
  assert.doesNotMatch(moderation, /SET\s+status\s*=/i);
});

test("authenticated requests revalidate active account and database role", async () => {
  const middleware = await source("src/middlewares/authMiddleware.js");
  assert.match(middleware, /SELECT u\.id,u\.full_name,u\.email,u\.username,u\.role_id,u\.is_active/);
  assert.match(middleware, /professional_claim_pending/);
  assert.match(middleware, /ACCOUNT_INACTIVE/);
  assert.match(middleware, /req\.user = decoded\.active_role === undefined \? user/);
  assert.match(middleware, /activateRole\(user, user\.roles/);
  assert.match(middleware, /Active role is no longer assigned/);
});

test("Client request updates cannot change operational or moderation fields", async () => {
  const controller = await source("src/controllers/serviceRequestController.js");
  const updateBlock = controller.slice(controller.indexOf("export const updateServiceRequest"), controller.indexOf("export const approveServiceRequest"));
  assert.doesNotMatch(updateBlock, /status:\s*"status"/);
  assert.doesNotMatch(updateBlock, /moderationStatus|approvedAt|approvedByUserId|requesterUserId|acceptedQuotationId/);
});

test("notification implementation targets recipients and requires database duplicate protection", async () => {
  const notifications = await source("src/services/adminNotificationService.js");
  assert.match(notifications, /INSERT INTO public\.admin_notifications/);
  assert.match(notifications, /recipient_user_id/);
  assert.match(notifications, /ON CONFLICT \(recipient_user_id, type, entity_type, entity_id\)/);
  assert.match(notifications, /DO NOTHING/);
});
