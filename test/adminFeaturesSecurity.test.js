import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { allowRoles } from "../src/middlewares/authMiddleware.js";
import { deleteServiceRequestById } from "../src/services/serviceRequestService.js";

const source = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

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

test("dependent cleanup targets only the selected service request", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM pg_constraint")) {
        return {
          rows: [{
            constraint_name: "quotations_service_request_id_fkey",
            child_schema: "public",
            child_table: "quotations",
            child_column: "service_request_id",
            parent_column: "id",
            delete_action: "r",
            column_count: 1,
          }],
        };
      }
      if (sql.includes('DELETE FROM "public"."quotations"')) return { rowCount: 2, rows: [] };
      return { rowCount: 1, rows: [{ id: 42 }] };
    },
  };

  const result = await deleteServiceRequestById(client, 42);
  assert.equal(result.deleted, true);
  assert.deepEqual(calls[1].params, [42]);
  assert.match(calls[1].sql, /WHERE "service_request_id" = \(SELECT "id" FROM public\.service_requests WHERE id = \$1\)/);
  assert.deepEqual(calls[2].params, [42]);
});

test("notification migration has recipient indexes and duplicate protection", async () => {
  const migration = await source("../Client_Onboarding_Migration/004_admin_notifications.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.admin_notifications/);
  assert.match(migration, /recipient_user_id INTEGER NOT NULL REFERENCES public\.users\(id\) ON DELETE CASCADE/);
  assert.match(migration, /WHERE read_at IS NULL/);
  assert.match(migration, /recipient_user_id, type, entity_type, entity_id/);
});
