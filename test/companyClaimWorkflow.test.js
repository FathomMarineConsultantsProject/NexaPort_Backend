import test from "node:test";
import assert from "node:assert/strict";
import { decideClaim, getPublicCompany, searchCompanies, submitClaim } from "../src/services/companyClaimService.js";

const entityId = "11111111-1111-4111-8111-111111111111";
const claimId = "22222222-2222-4222-8222-222222222222";
const company = { id: entityId, public_id: "COM-" + "A".repeat(32), company_name: "Oceanic Marine", directory_types: ["supplier", "ship_agent"] };

test("public search and detail return only the canonical company projection", async () => {
  const calls = [];
  const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [company] }; } };
  const list = await searchCompanies({ q: "Oceanic", limit: 100 }, db);
  assert.equal(list.data[0].id, entityId);
  assert.equal(list.limit, 30);
  assert.equal(calls[0].values[0], "Oceanic");
  assert.match(calls[0].sql, /review_status='approved'/);
  assert.doesNotMatch(calls[0].sql, /users|maritime_company_claims/);
  assert.equal((await getPublicCompany(entityId, db)).public_id, company.public_id);
});

test("claim submission targets an existing entity and grants no membership", async () => {
  const sql = [];
  const db = { query: async (statement) => {
    sql.push(statement);
    if (statement.includes("FROM maritime_directory_entities e")) return { rows: [company] };
    if (statement.includes("FROM maritime_company_memberships")) return { rows: [] };
    if (statement.includes("SELECT 1 FROM maritime_company_claims")) return { rows: [] };
    if (statement.includes("INSERT INTO maritime_company_claims")) return { rows: [{ id: claimId, status: "pending" }] };
    throw new Error(`Unexpected query: ${statement}`);
  } };
  const result = await submitClaim({ id: 7, full_name: "Applicant" }, { entityId, designation: "Director", businessEmail: "director@example.org", relationship: "I am authorized to represent this company." }, db);
  assert.equal(result.status, "pending");
  assert.equal(sql.filter(statement => statement.includes("INSERT INTO maritime_company_claims")).length, 1);
  assert.equal(sql.some(statement => /INSERT INTO maritime_directory_entities|INSERT INTO maritime_company_memberships/.test(statement)), false);
});

function decisionDb({ status = "pending", members = [], userId = 7 } = {}) {
  const statements = [];
  const db = { statements, connect: async () => ({
    query: async (sql) => {
      statements.push(sql);
      if (sql.startsWith("SELECT * FROM maritime_company_claims")) return { rows: [{ id: claimId, entity_id: entityId, claimant_user_id: userId, status }] };
      if (sql.includes("FROM maritime_company_memberships m")) return { rows: members };
      return { rows: [{ id: entityId }] };
    },
    release: () => {},
  }) };
  return db;
}

test("approval locks records, links a representative, records audit and commits", async () => {
  const db = decisionDb();
  const result = await decideClaim(claimId, "approve", { id: 1 }, "Verified company registration", db);
  assert.equal(result.status, "approved");
  assert.ok(db.statements.includes("BEGIN"));
  assert.ok(db.statements.some(sql => sql.includes("FOR UPDATE")));
  assert.ok(db.statements.some(sql => sql.includes("INSERT INTO maritime_company_memberships")));
  assert.ok(db.statements.some(sql => sql.includes("INSERT INTO public.admin_audit_logs")));
  assert.equal(db.statements.some(sql => /UPDATE\s+maritime_directory_entities|UPDATE\s+directory_entity_sources|DELETE\s+FROM\s+maritime_directory_entity_types/i.test(sql)), false);
  assert.equal(db.statements.at(-1), "COMMIT");
});

test("rejection keeps company untouched; decided and self-reviewed claims roll back", async () => {
  const rejected = decisionDb();
  await decideClaim(claimId, "reject", { id: 1 }, "Internal notes", rejected, "Insufficient company authority");
  assert.equal(rejected.statements.some(sql => sql.includes("INSERT INTO maritime_company_memberships")), false);
  assert.equal(rejected.statements.at(-1), "COMMIT");
  const decided = decisionDb({ status: "approved" });
  await assert.rejects(decideClaim(claimId, "approve", { id: 1 }, "Again", decided), { code: "CLAIM_DECIDED" });
  assert.equal(decided.statements.at(-1), "ROLLBACK");
  const self = decisionDb({ userId: 1 });
  await assert.rejects(decideClaim(claimId, "approve", { id: 1 }, "Self", self), { code: "SELF_REVIEW" });
  assert.equal(self.statements.at(-1), "ROLLBACK");
});

test("adding a representative to an already linked company requires explicit review notes", async () => {
  const db = decisionDb({ members: [{ user_id: 8, membership_role: "owner" }] });
  await assert.rejects(decideClaim(claimId, "approve", { id: 1 }, "", db), { code: "CONFLICT_NOTES_REQUIRED" });
  assert.equal(db.statements.at(-1), "ROLLBACK");
});

test("duplicate pending claim and already approved access are rejected", async () => {
  const input = { entityId, designation: "Director", businessEmail: "director@example.org", relationship: "I am authorized to represent this company." };
  for (const managed of [true, false]) {
    const db = { query: async sql => {
      if (sql.includes("FROM maritime_directory_entities e")) return { rows: [company] };
      if (sql.includes("FROM maritime_company_memberships")) return { rows: managed ? [{ membership_role: "owner" }] : [] };
      if (sql.includes("SELECT 1 FROM maritime_company_claims")) return { rows: [{ exists: true }] };
      throw new Error(`Unexpected query: ${sql}`);
    } };
    await assert.rejects(submitClaim({ id: 7, full_name: "Applicant" }, input, db), { code: managed ? "ALREADY_MANAGED" : "CLAIM_PENDING" });
  }
});
