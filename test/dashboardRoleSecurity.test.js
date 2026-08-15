import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const controllerPath = new URL("../src/controllers/dashboardController.js", import.meta.url);
const routesPath = new URL("../src/routes/dashboardRoutes.js", import.meta.url);

test("role-specific dashboard routes enforce authentication and exact server roles", async () => {
  const routes = await readFile(routesPath, "utf8");
  assert.match(routes, /router\.get\("\/client", requireAuth, requireApprovedClient, allowRoles\(3\), getClientDashboard\)/);
  assert.match(routes, /router\.get\("\/expert", requireAuth, allowRoles\(2\), getExpertDashboard\)/);
  assert.match(routes, /router\.get\("\/admin", requireAuth, allowRoles\(1\), getAdminDashboard\)/);
});

test("Client dashboard ownership and quotation visibility are database scoped", async () => {
  const source = await readFile(controllerPath, "utf8");
  const clientBlock = source.slice(source.indexOf("export const getClientDashboard"), source.indexOf("const expertProfileCte"));
  assert.ok((clientBlock.match(/sr\.requester_user_id = \$1/g) || []).length >= 5);
  assert.match(clientBlock, /q\.status = 'accepted'/);
  assert.doesNotMatch(clientBlock, /SELECT q\.\*/);
});

test("Expert private dashboard data stays tied to authenticated expert identity", async () => {
  const source = await readFile(controllerPath, "utf8");
  const expertBlock = source.slice(source.indexOf("const expertProfileCte"), source.indexOf("export const getAdminDashboard"));
  assert.match(expertBlock, /WHERE e\.user_id = \$1/);
  assert.ok((expertBlock.match(/q\.expert_user_id = \$1/g) || []).length >= 5);
  assert.match(expertBlock, /request_expert_assignments/);
  assert.match(expertBlock, /expert_ports/);
  assert.match(expertBlock, /expert_vessel_types/);
});

test("dashboard metrics retain truthful quotation and commission definitions", async () => {
  const source = await readFile(controllerPath, "utf8");
  assert.match(source, /AS accepted_quotation_value_usd/);
  assert.match(source, /SUM\(q\.admin_markup_usd\).*LOWER\(q\.status\) = 'accepted'/s);
  assert.doesNotMatch(source, /revenue_received|cash_earned|earnings/i);
});
