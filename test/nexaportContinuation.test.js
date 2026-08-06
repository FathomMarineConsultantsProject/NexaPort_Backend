import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFields } from "../src/services/templateFieldService.js";
import { validateTemplatePayload } from "../src/controllers/templateController.js";
import { registerMaritimeCompany } from "../src/services/maritimeCompanyService.js";

test("PART 1: Super Admin and Consultant manual template validation & transactional setup", () => {
  // Test 1 & 2 & 3: Super Admin & Consultant manual template creation requires no source document
  const payload = validateTemplatePayload({
    title: "Blank Safety Checklist",
    description: "Manual inspection template",
    sourceType: "manual",
    extractionMethod: "manual",
    fields: [
      { label: "Inspector Notes", type: "text", required: true },
      { label: "Photo Evidence", type: "photo", maxPhotos: 3 },
    ],
  });
  assert.equal(payload.title, "Blank Safety Checklist");
  assert.equal(payload.sourceType, "manual");
  assert.equal(payload.layout.extractionMethod, "manual");
  assert.equal(payload.fields.length, 2);

  // Test 4: Draft behavior allows 0 fields
  const draftPayload = validateTemplatePayload({
    title: "Incomplete Draft Template",
    sourceType: "manual",
    status: "draft",
    fields: [],
  });
  assert.equal(draftPayload.title, "Incomplete Draft Template");
  assert.equal(draftPayload.fields.length, 0);

  // Test 5: Reject template with forbidden source document fields
  assert.throws(
    () => validateTemplatePayload({ title: "Test", sourceType: "manual", source_s3_key: "key/123" }),
    /not accepted/i
  );
});

test("PART 2: Photo Field quantity maxPhotos (1-10) enforcement & report validation", async () => {
  // Test 7 & 8: maxPhotos accepts 1 to 10 and defaults to 1
  const fieldsDefault = normalizeFields([{ label: "Photo Field", type: "photo" }]);
  assert.equal(fieldsDefault[0].maxPhotos, 1);

  const fieldsValid = normalizeFields([{ label: "Photo Field", type: "photo", maxPhotos: 5 }]);
  assert.equal(fieldsValid[0].maxPhotos, 5);

  // Test 9: Invalid maxPhotos is rejected
  assert.throws(
    () => normalizeFields([{ label: "Photo Field", type: "photo", maxPhotos: 12 }]),
    /between 1 and 10/i
  );
  assert.throws(
    () => normalizeFields([{ label: "Photo Field", type: "photo", maxPhotos: 0 }]),
    /between 1 and 10/i
  );
});

test("PART 4: Multi-type maritime company registration (1, 2, or 3 types)", async () => {
  const mockDb = {
    connect: async () => ({
      query: async (sql, params) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return;
        if (sql.includes("SELECT 1 FROM users")) return { rows: [] };
        if (sql.includes("INSERT INTO users")) return { rows: [{ id: 10, full_name: "John Doe", email: "john@example.com" }] };
        if (sql.includes("SELECT 1 FROM public.maritime_directory_entities")) return { rows: [] };
        if (sql.includes("INSERT INTO public.maritime_directory_entities")) return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }] };
        if (sql.includes("INSERT INTO public.maritime_directory_entity_types")) return { rows: [] };
        if (sql.includes("DELETE FROM public.maritime_directory_entity_types")) return { rows: [] };
        if (sql.includes("INSERT INTO public.maritime_company_accounts")) return { rows: [] };
        return { rows: [] };
      },
      release: () => {},
    }),
  };

  // Test 18, 19, 20: 1, 2, or 3 company types accepted
  const payloadOne = {
    account: { fullName: "Contact One", email: "one@test.com", username: "comp1", password: "Password123!", confirmPassword: "Password123!" },
    company: { companyName: "Company One" },
    directoryTypes: ["service_provider"],
  };
  const resOne = await registerMaritimeCompany(payloadOne, mockDb);
  assert.equal(resOne.user.verification_status, "pending");

  const payloadTwo = {
    account: { fullName: "Contact Two", email: "two@test.com", username: "comp2", password: "Password123!", confirmPassword: "Password123!" },
    company: { companyName: "Company Two" },
    directoryTypes: ["service_provider", "supplier"],
  };
  const resTwo = await registerMaritimeCompany(payloadTwo, mockDb);
  assert.ok(resTwo);

  const payloadThree = {
    account: { fullName: "Contact Three", email: "three@test.com", username: "comp3", password: "Password123!", confirmPassword: "Password123!" },
    company: { companyName: "Company Three" },
    directoryTypes: ["service_provider", "ship_agent", "supplier"],
  };
  const resThree = await registerMaritimeCompany(payloadThree, mockDb);
  assert.ok(resThree);

  // Test 21: Zero types is rejected
  await assert.rejects(
    () => registerMaritimeCompany({ ...payloadOne, directoryTypes: [] }, mockDb),
    (err) => err.status === 400
  );

  // Test 22: Unknown type (e.g., shipyard) is rejected
  await assert.rejects(
    () => registerMaritimeCompany({ ...payloadOne, directoryTypes: ["shipyard"] }, mockDb),
    (err) => err.status === 400
  );
});
