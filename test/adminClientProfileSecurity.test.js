import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("admin Client account routes are Super Admin-only and user-keyed", async () => {
  const routes = await source("src/routes/adminAdministrationRoutes.js");
  assert.match(routes, /router\.use\(requireAuth, allowRoles\(1\)\)/);
  assert.match(routes, /get\("\/clients\/:userId", getClientAsAdmin\)/);
  assert.match(routes, /patch\("\/clients\/:userId", updateClientAsAdmin\)/);
  assert.match(routes, /put\("\/clients\/:userId\/onboarding-vessels", updateClientVesselsAsAdmin\)/);
  assert.match(routes, /put\("\/clients\/:userId\/required-services", updateClientServicesAsAdmin\)/);
  assert.match(routes, /get\("\/clients\/:userId\/documents\/:documentId\/download-url"/);
});

test("aggregated Client response uses explicit projections and safe ownership scopes", async () => {
  const service = await source("src/services/adminClientService.js");
  assert.match(service, /WHERE u\.id=\$1 AND u\.role_id=3/);
  assert.doesNotMatch(service, /SELECT\s+(cp|cc|u|users)\.\*/i);
  assert.doesNotMatch(service, /password_hash/);
  assert.doesNotMatch(service.match(/documents = await[\s\S]*?\[profileId\]\);/)[0], /s3_key/);
  assert.match(service, /service_requests WHERE requester_user_id=\$1/);
  assert.match(service, /vessels WHERE created_by_user_id=\$1/);
  assert.match(service, /expert_reviews WHERE reviewer_user_id=\$1/);
  assert.match(service, /recent_service_requests: recent\.rows/);
});

test("legacy Client completion does not fabricate formal verification", async () => {
  const service = await source("src/services/adminClientService.js");
  assert.match(service, /verification_status,verification_submitted_at,verified_at,verified_by_user_id\) VALUES \(\$1,NULL,NULL,'pending',NULL,NULL,NULL\)/);
  assert.doesNotMatch(service, /INSERT INTO client_verification_events/);
  assert.match(service, /!row\.verification_submitted_at && history\.rows\.length === 0/);
  assert.match(service, /missing_registration_data: missingFormalRegistration/);
});

test("generic Client editing is allowlisted and excludes account activation and verification state", async () => {
  const service = await source("src/services/adminClientService.js");
  const userFields = service.match(/const USER_FIELDS = \[[^\]]+\]/)[0];
  const profileFields = service.match(/const PROFILE_FIELDS = \[[^\]]+\]/)[0];
  assert.match(userFields, /full_name/);
  assert.match(userFields, /email/);
  assert.match(userFields, /phone/);
  assert.doesNotMatch(userFields, /is_active|role_id|password/);
  assert.doesNotMatch(profileFields, /verification_status|verified_at|verified_by_user_id/);
  assert.match(service, /LOWER\(email\)=LOWER\(\$1\)/);
  assert.match(service, /LOWER\(TRIM\(country\)\).*LOWER\(TRIM\(registration_number\)\)/s);
  assert.match(service, /code: "CLIENT_VALIDATION_FAILED"/);
});

test("Client fleet and service updates are transactional and ownership-controlled", async () => {
  const service = await source("src/services/adminClientService.js");
  assert.match(service, /export const updateAdminClientVessels[\s\S]*?await client\.query\("BEGIN"\)/);
  assert.match(service, /Vessel does not belong to this Client/);
  assert.match(service, /converted_vessel_id/);
  assert.match(service, /CONVERTED_VESSEL_CONFLICT/);
  assert.doesNotMatch(service, /payload\?\.converted_vessel_id|payload\?\.client_profile_id/);
  assert.match(service, /export const updateAdminClientServices[\s\S]*?await client\.query\("BEGIN"\)/);
  assert.match(service, /DELETE FROM client_required_services WHERE client_profile_id=\$1/);
  assert.match(service, /action: "client_updated"/);
});

test("admin document signing checks user, profile, document, current state, and storage prefix", async () => {
  const controller = await source("src/controllers/adminAdministrationController.js");
  const block = controller.slice(controller.indexOf("export const getClientDocumentDownloadUrlAsAdmin"), controller.indexOf("const queueClientDocuments"));
  assert.match(block, /u\.id=\$1 AND u\.role_id=3/);
  assert.match(block, /d\.client_profile_id=cp\.id/);
  assert.match(block, /d\.id=\$2 AND d\.is_current=TRUE/);
  assert.match(block, /startsWith\("client-verifications\/"\)/);
  assert.match(block, /expiresInSeconds: 600/);
  assert.doesNotMatch(block, /res\.json\([^)]*s3_key/);
});

test("permanent Client deletion requires confirmation and administrative reason", async () => {
  const controller = await source("src/controllers/adminAdministrationController.js");
  const block = controller.slice(controller.indexOf("export const deleteClientAsAdmin"), controller.indexOf("export const deactivateClientAsAdmin"));
  assert.match(block, /confirmation!=="DELETE"\|\|!reason/);
  assert.match(block, /hasImmutableHistory/);
  assert.match(block, /reason\}\)/);
  assert.doesNotMatch(block, /error\.message\}\);\}finally/);
});
