import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import jwt from "jsonwebtoken";
import { pool } from "../src/config/db.js";
import {
  approveClientRegistration,
} from "../src/controllers/adminClientRegistrationController.js";
import {
  confirmClientRegistrationDocument,
  createClientRegistrationDraft,
  presignClientRegistrationDocument,
  registerClient,
} from "../src/controllers/clientRegistrationController.js";
import { allowRoles, requireAuth } from "../src/middlewares/authMiddleware.js";
import {
  createRegistrationDraftToken,
  normalizeEmail,
  registrationDraftMatchesEmail,
  verifyRegistrationDraftToken,
} from "../src/services/clientRegistrationSecurity.js";
import {
  MAX_DOCUMENT_SIZE,
  createDocumentConfirmationToken,
  keyBelongsToOwner,
  validateDocumentInput,
} from "../src/services/clientDocumentService.js";
import { setPrivateObjectClientForTests } from "../src/services/privateObjectService.js";

process.env.CLIENT_REGISTRATION_TOKEN_SECRET = "test-only-registration-secret";
process.env.JWT_SECRET = "test-only-jwt-secret";
process.env.AWS_REGION = "ap-south-1";
process.env.AWS_S3_BUCKET = "nexaport-client-test";
process.env.AWS_ACCESS_KEY_ID = "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";

const mockResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

const runApproval = async ({ status = "pending", hasCompany = true, hasServices = true, documentCount = 0 } = {}) => {
  const calls = [];
  const documents = [
    "company_registration_certificate",
    "authorisation_letter",
    "company_identification_or_tax_certificate",
  ].slice(0, documentCount).map((document_category, index) => ({
    id: index + 1,
    document_category,
    original_filename: `${document_category}.pdf`,
    mime_type: "application/pdf",
    size_bytes: 100,
    is_current: true,
    uploaded_at: new Date(0),
  }));
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("SELECT cp.*")) return { rows: [{ id: 42, user_id: 7, verification_status: status }] };
      if (sql.includes("FROM client_companies")) return { rows: hasCompany ? [{ id: 1, client_profile_id: 42 }] : [] };
      if (sql.includes("FROM client_onboarding_vessels")) return { rows: [] };
      if (sql.includes("FROM client_required_services")) return { rows: hasServices ? [{ id: 1, service_name_snapshot: "Condition Inspection" }] : [] };
      if (sql.includes("FROM client_verification_documents")) return { rows: documents };
      if (sql.includes("FROM client_verification_events")) return { rows: [] };
      if (sql.startsWith("UPDATE client_profiles") || sql.startsWith("INSERT INTO client_verification_events")) return { rows: [] };
      throw new Error(`Unexpected approval query: ${sql}`);
    },
    release() {},
  };
  const originalConnect = pool.connect;
  pool.connect = async () => client;
  const res = mockResponse();
  try {
    await approveClientRegistration({ params: { id: "42" }, body: {}, user: { id: 99, role_id: 1 } }, res);
  } finally {
    pool.connect = originalConnect;
  }
  return { calls, res };
};

test("pending Client approval accepts zero, one, two, or three verification documents", async (t) => {
  for (const documentCount of [0, 1, 2, 3]) {
    await t.test(`${documentCount} documents`, async () => {
      const { calls, res } = await runApproval({ documentCount });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.verification_status, "approved");
      assert.equal(calls.some(({ sql }) => sql === "COMMIT"), true);
      assert.equal(calls.some(({ sql }) => sql.startsWith("INSERT INTO client_verification_events")), true);
      const update = calls.find(({ sql }) => sql.startsWith("UPDATE client_profiles"));
      assert.match(update.sql, /verified_at=CURRENT_TIMESTAMP/);
      assert.match(update.sql, /verified_by_user_id=\$1/);
      assert.deepEqual(update.params, [99, null, 42]);
    });
  }
});

test("approval still requires company details and at least one service", async (t) => {
  await t.test("missing company", async () => {
    const { res } = await runApproval({ hasCompany: false });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.message, "Company details are required.");
  });
  await t.test("missing services", async () => {
    const { res } = await runApproval({ hasServices: false });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.message, "At least one required service is required.");
  });
});

test("approved and rejected Client registrations cannot be approved", async (t) => {
  for (const status of ["approved", "rejected"]) {
    await t.test(status, async () => {
      const { res } = await runApproval({ status });
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.message, "Only pending registrations can be approved.");
    });
  }
});

test("approval authorization rejects unauthenticated, Consultant, and Client requests", async () => {
  const unauthenticated = mockResponse();
  await requireAuth({ headers: {} }, unauthenticated, () => assert.fail("Unauthenticated request passed"));
  assert.equal(unauthenticated.statusCode, 401);

  const guard = allowRoles(1);
  for (const role_id of [2, 3]) {
    const denied = mockResponse();
    guard({ user: { role_id } }, denied, () => assert.fail(`Role ${role_id} passed`));
    assert.equal(denied.statusCode, 403);
  }
});

test("approval no longer contains a verification-document eligibility check", async () => {
  const controller = await readFile(new URL("../src/controllers/adminClientRegistrationController.js", import.meta.url), "utf8");
  assert.doesNotMatch(controller, /All required current verification documents|DOCUMENT_CATEGORIES\.some/);
});

test("signed document download remains Super Admin-only and current-document scoped", async () => {
  const routes = await readFile(new URL("../src/routes/adminClientRegistrationRoutes.js", import.meta.url), "utf8");
  const controller = await readFile(new URL("../src/controllers/adminClientRegistrationController.js", import.meta.url), "utf8");
  assert.match(routes, /router\.use\(requireAuth, allowRoles\(1\)\)/);
  assert.match(routes, /documents\/:documentId\/download-url/);
  assert.match(controller, /client_profile_id=\$2 AND is_current=TRUE/);
  assert.match(controller, /createPresignedGetUrl/);
});

test("registration draft endpoint returns a signed token for an available normalized email without SMTP", async () => {
  const originalQuery = pool.query;
  pool.query = async () => ({ rows: [] });
  const res = mockResponse();
  try {
    await createClientRegistrationDraft({ body: { email: " New.Client@Example.com " }, ip: "draft-endpoint-test" }, res);
  } finally {
    pool.query = originalQuery;
  }
  assert.equal(res.statusCode, 200);
  assert.equal(typeof res.body.registrationDraftToken, "string");
  assert.equal(res.body.expiresIn, "60m");
  const identity = verifyRegistrationDraftToken(res.body.registrationDraftToken);
  assert.equal(identity.email, "new.client@example.com");
  assert.match(identity.draftId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("draft tokens bind normalized email, draft ID, and purpose", () => {
  const token = createRegistrationDraftToken({ email: " User@Example.com ", draftId: "draft-id" });
  const decoded = verifyRegistrationDraftToken(token);
  assert.equal(decoded.email, "user@example.com");
  assert.equal(decoded.draftId, "draft-id");
  assert.equal(decoded.purpose, "client-registration-draft");
  assert.equal(normalizeEmail(" User@Example.com "), "user@example.com");
});

test("expired and wrong-purpose tokens are rejected", async () => {
  const expired = createRegistrationDraftToken({ email: "user@example.com", draftId: "draft-id", expiresIn: "1ms" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.throws(() => verifyRegistrationDraftToken(expired), /expired/i);

  const wrongPurpose = jwt.sign(
    { email: "user@example.com", draftId: "draft-id", purpose: "something-else" },
    process.env.CLIENT_REGISTRATION_TOKEN_SECRET,
    { expiresIn: "1h" }
  );
  assert.throws(() => verifyRegistrationDraftToken(wrongPurpose), /invalid registration draft token/i);
});

test("draft identity rejects cross-email use", () => {
  const identity = verifyRegistrationDraftToken(createRegistrationDraftToken({ email: "first@example.com", draftId: "draft-one" }));
  assert.equal(registrationDraftMatchesEmail(identity, " FIRST@example.com "), true);
  assert.equal(registrationDraftMatchesEmail(identity, "second@example.com"), false);
  assert.equal(registrationDraftMatchesEmail({ email: identity.email }, identity.email), false);
});

test("invalid and expired draft tokens cannot obtain upload URLs", async () => {
  const invalidResponse = mockResponse();
  await presignClientRegistrationDocument({ headers: { authorization: "Bearer invalid" }, body: {}, ip: "invalid-upload-test" }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 401);

  const expired = createRegistrationDraftToken({ email: "user@example.com", draftId: "expired-draft", expiresIn: "1ms" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const expiredResponse = mockResponse();
  await presignClientRegistrationDocument({ headers: { authorization: `Bearer ${expired}` }, body: {}, ip: "expired-upload-test" }, expiredResponse);
  assert.equal(expiredResponse.statusCode, 401);
});

test("a draft token cannot confirm another draft's or an arbitrary S3 key", async () => {
  const token = createRegistrationDraftToken({ email: "user@example.com", draftId: "draft-one" });
  const baseRequest = {
    headers: { authorization: `Bearer ${token}` },
    ip: "confirm-key-test",
    body: { category: "authorisation_letter", contentType: "application/pdf", size: 100, originalFilename: "letter.pdf" },
  };
  const otherDraftResponse = mockResponse();
  await confirmClientRegistrationDocument({ ...baseRequest, body: { ...baseRequest.body, key: "client-verifications/drafts/draft-two/authorisation_letter/id.pdf" } }, otherDraftResponse);
  assert.equal(otherDraftResponse.statusCode, 400);

  const arbitraryResponse = mockResponse();
  await confirmClientRegistrationDocument({ ...baseRequest, body: { ...baseRequest.body, key: "private/arbitrary.pdf" } }, arbitraryResponse);
  assert.equal(arbitraryResponse.statusCode, 400);
});

test("verification documents enforce category, MIME, size, and owner prefix", () => {
  const valid = { category: "authorisation_letter", contentType: "application/pdf", size: MAX_DOCUMENT_SIZE, originalFilename: "letter.pdf" };
  assert.equal(validateDocumentInput(valid), null);
  assert.ok(validateDocumentInput({ ...valid, category: "arbitrary" }));
  assert.ok(validateDocumentInput({ ...valid, contentType: "text/html" }));
  assert.ok(validateDocumentInput({ ...valid, size: MAX_DOCUMENT_SIZE + 1 }));
  assert.equal(keyBelongsToOwner({ key: "client-verifications/drafts/draft-id/authorisation_letter/id.pdf", ownerType: "drafts", ownerId: "draft-id", category: "authorisation_letter", contentType: "application/pdf" }), true);
  assert.equal(keyBelongsToOwner({ key: "client-verifications/drafts/other/authorisation_letter/id.pdf", ownerType: "drafts", ownerId: "draft-id", category: "authorisation_letter", contentType: "application/pdf" }), false);
  assert.equal(keyBelongsToOwner({ key: "client-verifications/drafts/draft-id/authorisation_letter/../id.pdf", ownerType: "drafts", ownerId: "draft-id", category: "authorisation_letter", contentType: "application/pdf" }), false);
});

test("valid files receive a correctly scoped presigned URL and confirmed document token", async () => {
  const draftId = "upload-draft";
  const token = createRegistrationDraftToken({ email: "upload@example.com", draftId });
  const metadata = { category: "authorisation_letter", contentType: "application/pdf", size: 321, originalFilename: "letter.pdf" };
  const presignResponse = mockResponse();
  await presignClientRegistrationDocument({ headers: { authorization: `Bearer ${token}` }, body: metadata, ip: "valid-upload-test" }, presignResponse);
  assert.equal(presignResponse.statusCode, 200);
  const url = new URL(presignResponse.body.uploadUrl);
  assert.equal(url.hostname, "nexaport-client-test.s3.ap-south-1.amazonaws.com");
  assert.match(decodeURIComponent(url.pathname), new RegExp(`client-verifications/drafts/${draftId}/authorisation_letter/.+\\.pdf$`));

  setPrivateObjectClientForTests({ send: async () => ({ ContentLength: 321, ContentType: "application/pdf" }) });
  const confirmResponse = mockResponse();
  await confirmClientRegistrationDocument({ headers: { authorization: `Bearer ${token}` }, body: { ...metadata, key: presignResponse.body.key }, ip: "valid-confirm-test" }, confirmResponse);
  assert.equal(confirmResponse.statusCode, 200);
  assert.equal(typeof confirmResponse.body.documentToken, "string");
});

const registrationPayload = (email, documentTokens = []) => ({
  full_name: "Test Client", designation: "Manager", email, mobile_number: "+65 1234 5678", password: "Password1",
  company: { legal_name: `Company ${email}`, company_type: "Ship Owner", registered_address: "1 Harbour Road", country: "Singapore", registration_number: `REG-${email}`, authorized_representative_name: "Test Client", authorized_representative_email: email, authorized_representative_phone: "+65 1234 5678" },
  declared_vessel_count: 0, vessels: [], services: [{ name: "Condition Inspection" }], documentTokens,
});

const runRegistration = async ({ documentCount = 0, failAt = "", duplicate = false, notificationFailure = false, existingAccount = false, requestUser = null, profileExists = false, profileId = 42, databaseError = null } = {}) => {
  const draftId = `registration-draft-${documentCount}-${failAt || "ok"}`;
  const email = `${draftId}@example.com`;
  const categories = ["company_registration_certificate", "authorisation_letter", "company_identification_or_tax_certificate"];
  const documentTokens = categories.slice(0, documentCount).map((category, index) => createDocumentConfirmationToken({
    draftId, key: `client-verifications/drafts/${draftId}/${category}/file-${index}.pdf`, category,
    contentType: "application/pdf", size: 100 + index, originalFilename: `${category}.pdf`,
  }));
  const calls = [];
  const queryCalls = [];
  const client = {
    async query(sql, params) {
      calls.push(sql);
      queryCalls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM users WHERE LOWER(email)")) return { rows: (duplicate || existingAccount) ? [{ id: 7, full_name: "Existing Client", email, username: "existing", role_id: 3, phone: "+65", is_active: true }] : [] };
      if (sql.includes("SELECT id FROM client_profiles WHERE user_id")) return { rows: profileExists ? [{ id: 9 }] : [] };
      if (sql.includes("SELECT id FROM users WHERE username")) return { rows: [] };
      if (sql.startsWith("INSERT INTO users")) return { rows: [{ id: 7, full_name: "Test Client", email, username: "test_1234", role_id: 3, phone: "+65", is_active: true }] };
      if (sql.startsWith("INSERT INTO client_profiles")) return { rows: [{ id: profileId, user_id: 7, verification_submitted_at: new Date(0) }] };
      if (sql.startsWith("INSERT INTO client_companies")) { if (databaseError) throw databaseError; if (failAt === "company") throw Object.assign(new Error("database detail"), { code: "XX001" }); return { rows: [] }; }
      if (sql.includes("FROM master_service_types")) return { rows: [{ service_type_id: 1, service_category_id: null }] };
      if (sql.startsWith("INSERT INTO client_required_services") || sql.startsWith("INSERT INTO client_verification_documents") || sql.startsWith("INSERT INTO client_verification_events")) return { rows: [] };
      throw new Error(`Unexpected registration query: ${sql}`);
    }, release() {},
  };
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  pool.connect = async () => client;
  pool.query = async () => { if (notificationFailure) throw Object.assign(new Error("notification unavailable"), { code: "42P01" }); return { rows: [], rowCount: 0 }; };
  const res = mockResponse();
  const originalWarn = console.warn; const originalError = console.error; console.warn = () => {}; console.error = () => {};
  try {
    await registerClient({ headers: { authorization: `Bearer ${createRegistrationDraftToken({ email, draftId })}` }, body: registrationPayload(email, documentTokens), ip: draftId, user: requestUser }, res);
  } finally {
    pool.connect = originalConnect; pool.query = originalQuery; console.warn = originalWarn; console.error = originalError;
  }
  return { res, calls, queryCalls };
};

test("registration succeeds atomically with zero, one, two, or three optional documents", async (t) => {
  for (const documentCount of [0, 1, 2, 3]) await t.test(`${documentCount} documents`, async () => {
    const { res, calls } = await runRegistration({ documentCount });
    assert.equal(res.statusCode, 201);
    assert.equal(calls.filter((sql) => sql.startsWith("INSERT INTO client_verification_documents")).length, documentCount);
    assert.ok(calls.includes("COMMIT"));
  });
});

test("invalid document tokens are rejected before a registration transaction starts", async () => {
  const draftId = "invalid-document-draft"; const email = "invalid-document@example.com";
  const res = mockResponse();
  await registerClient({ headers: { authorization: `Bearer ${createRegistrationDraftToken({ email, draftId })}` }, body: registrationPayload(email, ["fake-token"]), ip: draftId }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /document confirmations/i);
});

test("core database failure rolls back, duplicate email remains a conflict, and notification failure does not falsify success", async () => {
  const failed = await runRegistration({ failAt: "company" });
  assert.equal(failed.res.statusCode, 500);
  assert.ok(failed.calls.includes("ROLLBACK"));
  assert.ok(!failed.calls.includes("COMMIT"));
  assert.equal(failed.res.body.code, "CLIENT_REGISTRATION_FAILED");

  const duplicate = await runRegistration({ duplicate: true });
  assert.equal(duplicate.res.statusCode, 409);
  assert.equal(duplicate.res.body.code, "ACCOUNT_EMAIL_EXISTS");

  const notified = await runRegistration({ notificationFailure: true });
  assert.equal(notified.res.statusCode, 201);
  assert.ok(notified.calls.includes("COMMIT"));
  assert.ok(!notified.calls.includes("ROLLBACK"));
});

test("duplicate company identity and contact values remain application data, not account identity", async (t) => {
  const migration = await readFile(new URL("../sql/client_registration_001_allow_duplicate_company_data.sql", import.meta.url), "utf8");
  await t.test("two registrations may share a company registration number", () => assert.match(migration, /DROP CONSTRAINT IF EXISTS client_companies_registration_number_key/));
  await t.test("two registrations may share an IMO company number", () => assert.match(migration, /DROP CONSTRAINT IF EXISTS client_companies_imo_company_number_key/));
  await t.test("two registrations may share a company legal name", () => assert.match(migration, /'legal_name'/));
  await t.test("two registrations may share an official company contact email", () => assert.match(migration, /'authorized_representative_email'/));
  assert.match(migration, /CREATE INDEX IF NOT EXISTS client_companies_registration_number_idx/);
  assert.doesNotMatch(migration, /CREATE UNIQUE INDEX IF NOT EXISTS client_companies/);
  assert.doesNotMatch(migration, /DROP CONSTRAINT IF EXISTS client_companies_pkey/);

  const first = await runRegistration({ profileId: 42 });
  const second = await runRegistration({ profileId: 43 });
  assert.equal(first.res.statusCode, 201);
  assert.equal(second.res.statusCode, 201);
  assert.ok(first.calls.some((sql) => sql.startsWith("INSERT INTO client_companies")));
  assert.ok(second.calls.some((sql) => sql.startsWith("INSERT INTO client_companies")));
});

test("separate registrations retain distinct internal profile IDs", async () => {
  const first = await runRegistration({ profileId: 42 });
  const second = await runRegistration({ profileId: 43 });
  const firstCompany = first.queryCalls.find(({ sql }) => sql.startsWith("INSERT INTO client_companies"));
  const secondCompany = second.queryCalls.find(({ sql }) => sql.startsWith("INSERT INTO client_companies"));
  assert.equal(firstCompany.params[0], 42);
  assert.equal(secondCompany.params[0], 43);
  assert.notEqual(firstCompany.params[0], secondCompany.params[0]);
});

test("an authenticated existing Client account is reused without changing login credentials", async () => {
  const result = await runRegistration({ existingAccount: true, requestUser: { id: 7, role_id: 3 } });
  assert.equal(result.res.statusCode, 201);
  assert.equal(result.calls.some((sql) => sql.startsWith("INSERT INTO users")), false);
  assert.equal(result.calls.some((sql) => sql.startsWith("UPDATE users")), false);
  assert.equal(result.calls.some((sql) => sql.startsWith("INSERT INTO client_profiles")), true);
});

test("login email uniqueness is preserved and an unrelated 23505 is never mislabeled", async () => {
  const duplicate = await runRegistration({ duplicate: true });
  assert.equal(duplicate.res.statusCode, 409);
  assert.equal(duplicate.res.body.code, "ACCOUNT_EMAIL_EXISTS");

  const unrelated = await runRegistration({ databaseError: Object.assign(new Error("internal detail"), { code: "23505", table: "client_companies", constraint: "unexpected_business_rule_key" }) });
  assert.equal(unrelated.res.statusCode, 500);
  assert.equal(unrelated.res.body.code, "CLIENT_REGISTRATION_FAILED");
  assert.doesNotMatch(unrelated.res.body.message, /already exists|registration number|imo/i);
});

test("public registration routes expose drafts but not legacy email verification", async () => {
  const routes = await readFile(new URL("../src/routes/authRoutes.js", import.meta.url), "utf8");
  assert.match(routes, /client-registration\/draft/);
  assert.doesNotMatch(routes, /email-otp|requestClientEmail|verifyClientEmail/i);
});

test("client creation remains server-controlled as role 3 with pending verification", async () => {
  const controller = await readFile(new URL("../src/controllers/clientRegistrationController.js", import.meta.url), "utf8");
  assert.match(controller, /role_id, phone, is_active\) VALUES \(\$1,\$2,\$3,\$4,3,/);
  assert.match(controller, /verification_status, verification_submitted_at\) VALUES \(\$1,\$2,\$3,'pending'/);
  assert.doesNotMatch(controller, /email_verification_challenges|sendClientRegistration/i);
});

test("client verification documents are optional without allowing duplicate categories", async () => {
  const controller = await readFile(new URL("../src/controllers/clientRegistrationController.js", import.meta.url), "utf8");
  assert.doesNotMatch(controller, /documents\.length !== DOCUMENT_CATEGORIES\.length/);
  assert.match(controller, /categories\.size !== documents\.length/);
});

test("generic public registration cannot accept role 1 or role 2", async () => {
  const controller = await readFile(new URL("../src/controllers/authController.js", import.meta.url), "utf8");
  assert.match(controller, /passwordHash,\s*3,\s*phone/);
  assert.doesNotMatch(controller, /req\.body\.(role|role_id)|requestedRoleId/);
});

test("approval middleware and Super Admin review routes remain enforced", async () => {
  const middleware = await readFile(new URL("../src/middlewares/clientApprovalMiddleware.js", import.meta.url), "utf8");
  const adminRoutes = await readFile(new URL("../src/routes/adminClientRegistrationRoutes.js", import.meta.url), "utf8");
  assert.match(middleware, /verification_status[^\n]*approved/i);
  assert.match(adminRoutes, /allowRoles\(1\)/);
  assert.match(adminRoutes, /approve|reject/);
});
