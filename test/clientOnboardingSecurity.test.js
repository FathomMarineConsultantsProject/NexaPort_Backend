import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import jwt from "jsonwebtoken";
import { pool } from "../src/config/db.js";
import {
  confirmClientRegistrationDocument,
  createClientRegistrationDraft,
  presignClientRegistrationDocument,
} from "../src/controllers/clientRegistrationController.js";
import {
  createRegistrationDraftToken,
  normalizeEmail,
  registrationDraftMatchesEmail,
  verifyRegistrationDraftToken,
} from "../src/services/clientRegistrationSecurity.js";
import {
  MAX_DOCUMENT_SIZE,
  keyBelongsToOwner,
  validateDocumentInput,
} from "../src/services/clientDocumentService.js";

process.env.CLIENT_REGISTRATION_TOKEN_SECRET = "test-only-registration-secret";

const mockResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
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
