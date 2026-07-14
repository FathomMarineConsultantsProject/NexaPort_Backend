import assert from "node:assert/strict";
import test from "node:test";
import {
  createOtp,
  createRegistrationToken,
  digestOtp,
  normalizeEmail,
  otpMatches,
  verifyRegistrationToken,
} from "../src/services/clientRegistrationSecurity.js";
import {
  MAX_DOCUMENT_SIZE,
  keyBelongsToOwner,
  validateDocumentInput,
} from "../src/services/clientDocumentService.js";

process.env.OTP_PEPPER = "test-only-otp-pepper";
process.env.CLIENT_REGISTRATION_TOKEN_SECRET = "test-only-registration-secret";

test("OTP values are six random digits and are stored as non-plaintext digests", () => {
  const values = new Set(Array.from({ length: 20 }, createOtp));
  assert.ok([...values].every((value) => /^\d{6}$/.test(value)));
  assert.ok(values.size > 1);
  const digest = digestOtp({ email: " User@Example.com ", draftId: "draft", otp: "123456" });
  assert.notEqual(digest, "123456");
  assert.equal(otpMatches({ expectedDigest: digest, candidateDigest: digestOtp({ email: "user@example.com", draftId: "draft", otp: "123456" }) }), true);
  assert.equal(otpMatches({ expectedDigest: digest, candidateDigest: digestOtp({ email: "user@example.com", draftId: "draft", otp: "654321" }) }), false);
});

test("registration tokens bind normalized email, draft, challenge, and purpose", () => {
  const token = createRegistrationToken({ email: " User@Example.com ", draftId: "draft-id", challengeId: 42 });
  const decoded = verifyRegistrationToken(token);
  assert.equal(decoded.email, "user@example.com");
  assert.equal(decoded.draftId, "draft-id");
  assert.equal(decoded.challengeId, 42);
  assert.equal(decoded.purpose, "verified-client-email");
  assert.equal(normalizeEmail(" User@Example.com "), "user@example.com");
});

test("verification documents enforce category, MIME, size, and owner prefix", () => {
  const valid = { category: "authorisation_letter", contentType: "application/pdf", size: MAX_DOCUMENT_SIZE, originalFilename: "letter.pdf" };
  assert.equal(validateDocumentInput(valid), null);
  assert.ok(validateDocumentInput({ ...valid, contentType: "text/html" }));
  assert.ok(validateDocumentInput({ ...valid, size: MAX_DOCUMENT_SIZE + 1 }));
  assert.equal(keyBelongsToOwner({ key: "client-verifications/drafts/draft-id/authorisation_letter/id.pdf", ownerType: "drafts", ownerId: "draft-id", category: "authorisation_letter", contentType: "application/pdf" }), true);
  assert.equal(keyBelongsToOwner({ key: "client-verifications/drafts/other/authorisation_letter/id.pdf", ownerType: "drafts", ownerId: "draft-id", category: "authorisation_letter", contentType: "application/pdf" }), false);
  assert.equal(keyBelongsToOwner({ key: "client-verifications/drafts/draft-id/authorisation_letter/../id.pdf", ownerType: "drafts", ownerId: "draft-id", category: "authorisation_letter", contentType: "application/pdf" }), false);
});
