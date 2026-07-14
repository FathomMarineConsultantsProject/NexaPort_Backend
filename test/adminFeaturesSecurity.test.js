import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { allowRoles } from "../src/middlewares/authMiddleware.js";

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

test("delete-all is ordered before single delete and requires Super Admin confirmation", async () => {
  const [routes, controller] = await Promise.all([
    source("src/routes/serviceRequestRoutes.js"),
    source("src/controllers/serviceRequestController.js"),
  ]);

  const allRoute = routes.indexOf('router.delete("/all"');
  const singleRoute = routes.indexOf('router.delete("/:id"');
  assert.ok(allRoute >= 0 && singleRoute > allRoute);
  assert.match(routes, /delete\("\/all", requireAuth, allowRoles\(1\), deleteAllServiceRequests\)/);
  assert.match(controller, /req\.body\?\.confirmation !== "DELETE ALL"/);
  assert.match(controller, /FROM pg_constraint con/);
  assert.match(controller, /await client\.query\("BEGIN"\)/);
  assert.match(controller, /await client\.query\("COMMIT"\)/);
  assert.match(controller, /await client\.query\("ROLLBACK"\)/);
});

test("notification migration has recipient indexes and duplicate protection", async () => {
  const migration = await source("../Client_Onboarding_Migration/004_admin_notifications.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.admin_notifications/);
  assert.match(migration, /recipient_user_id INTEGER NOT NULL REFERENCES public\.users\(id\) ON DELETE CASCADE/);
  assert.match(migration, /WHERE read_at IS NULL/);
  assert.match(migration, /recipient_user_id, type, entity_type, entity_id/);
});
