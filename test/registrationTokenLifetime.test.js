import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { createRegistrationDraftToken, parseRegistrationTokenLifetime } from "../src/services/clientRegistrationSecurity.js";

test("registration lifetime is bounded and unambiguous for environment strings", () => {
  assert.equal(parseRegistrationTokenLifetime(undefined), 3600);
  for (const [input, seconds] of [["60m", 3600], ["3600", 3600], ["1h", 3600], ["1d", 86400], [60, 60]])
    assert.equal(parseRegistrationTokenLifetime(input), seconds);
  for (const input of ["bad", "1ms", "0", "59", "25h", "-1", "Infinity", "1.5h", " "])
    assert.throws(() => parseRegistrationTokenLifetime(input), { code: "REGISTRATION_TOKEN_TTL_INVALID" });
});

test("issued draft has the configured expiry and malformed configuration fails closed", () => {
  const secret = process.env.CLIENT_REGISTRATION_TOKEN_SECRET;
  const ttl = process.env.CLIENT_REGISTRATION_TOKEN_TTL;
  try {
    process.env.CLIENT_REGISTRATION_TOKEN_SECRET = "test-only-lifetime-secret";
    process.env.CLIENT_REGISTRATION_TOKEN_TTL = "3600";
    const token = createRegistrationDraftToken({ email: "USER@example.com", draftId: "draft-1" });
    const decoded = jwt.verify(token, process.env.CLIENT_REGISTRATION_TOKEN_SECRET);
    assert.equal(decoded.exp - decoded.iat, 3600);
    assert.equal(decoded.email, "user@example.com");
    process.env.CLIENT_REGISTRATION_TOKEN_TTL = "forever";
    assert.throws(() => createRegistrationDraftToken({ email: "user@example.com", draftId: "draft-1" }), { code: "REGISTRATION_TOKEN_TTL_INVALID" });
  } finally {
    if (secret === undefined) delete process.env.CLIENT_REGISTRATION_TOKEN_SECRET; else process.env.CLIENT_REGISTRATION_TOKEN_SECRET = secret;
    if (ttl === undefined) delete process.env.CLIENT_REGISTRATION_TOKEN_TTL; else process.env.CLIENT_REGISTRATION_TOKEN_TTL = ttl;
  }
});
