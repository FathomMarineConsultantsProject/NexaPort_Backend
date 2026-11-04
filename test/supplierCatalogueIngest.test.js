import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestSupplierBatch, normalizeImpa } from '../src/services/supplierCatalogueIngestService.js';

const entry = { impaCode: 'IMPA 001234', supplierId: '11111111-1111-4111-8111-111111111111', nexaportCompanyId: 'NXP-1', externalSourceName: 'ShipServ', externalSourceId: '123', sourceUrl: 'https://approved.example/item', evidenceText: 'Supplier offers IMPA 001234 as part ABC', explicitOffer: true, documentSha256: 'a'.repeat(64), extractedAt: '2026-11-04T00:00:00Z', extractionMethod: 'fixture', sourceUseApproved: true, publicationApproved: true, sourceUseApprovalId: 'test-source-grant', publicationApprovalId: 'test-publication-grant' };
function fakeDb({ product = true, supplier = true, existing = false, evidenceNew = false, policy = true } = {}) {
  const calls = [];
  return { calls, connect: async () => ({ query: async (sql) => { calls.push(sql); if (sql.includes('FROM public.supplier_catalogue_source_policies')) return { rows: policy ? [{ source_url: entry.sourceUrl, nexaport_company_id: entry.nexaportCompanyId, supplier_identity_status: 'verified', supplier_identity_evidence: 'fixture identity', offering_confirmation_status: 'documented', offering_scope: 'all_catalogue_rows', offering_evidence: 'fixture offer', internal_authorization_status: 'documented', internal_authorization_evidence: 'fixture internal', publication_rights_status: 'documented', publication_rights_evidence: 'fixture rights', publication_rights_scope: 'commercial_publication', approved_host: 'approved.example' }] : [] }; if (sql.includes('FROM public.catalog_products WHERE')) return { rows: product ? [{ id: 'p1' }] : [] }; if (sql.includes('FROM public.catalog_suppliers s JOIN')) return { rows: supplier ? [{ id: 's1' }] : [] }; if (sql.includes('SELECT id FROM public.supplier_product_relationships')) return { rows: existing ? [{ id: 'r1' }] : [] }; if (sql.includes('INSERT INTO public.supplier_product_relationships')) return { rows: [{ id: 'r2' }] }; if (sql.includes('INSERT INTO public.catalog_relationship_evidence')) return { rows: evidenceNew ? [{ relationship_id: 'r1' }] : [] }; return { rows: [] }; }, release() {} }) };
}
test('normalization retains leading zeros', () => assert.equal(normalizeImpa('IMPA 001234'), '001234'));
test('verified offer inserts and duplicate preserves existing pair', async () => {
  process.env.SUPPLIER_CATALOGUE_APPROVED_HOSTS = 'approved.example';
  const db = fakeDb();
  assert.equal((await ingestSupplierBatch(db, [entry], { dryRun: false, batchId: 'a' }))[0].status, 'inserted');
  const duplicate = fakeDb({ existing: true });
  assert.equal((await ingestSupplierBatch(duplicate, [entry], { dryRun: false, batchId: 'b' }))[0].status, 'already_exists');
  assert.equal((await ingestSupplierBatch(fakeDb({ existing: true, evidenceNew: true }), [entry], { dryRun: false, batchId: 'b2' }))[0].status, 'updated_evidence');
  assert.equal(duplicate.calls.filter(sql => sql.includes('INSERT INTO public.supplier_product_relationships')).length, 0);
});
test('unknown product and unresolved supplier require review', async () => {
  process.env.SUPPLIER_CATALOGUE_APPROVED_HOSTS = 'approved.example';
  assert.equal((await ingestSupplierBatch(fakeDb({ product: false }), [entry], { batchId: 'c' }))[0].status, 'unknown_product');
  assert.equal((await ingestSupplierBatch(fakeDb({ supplier: false }), [entry], { batchId: 'd' }))[0].status, 'needs_review');
});
test('unsupported evidence and unapproved source never insert', async () => {
  process.env.SUPPLIER_CATALOGUE_APPROVED_HOSTS = 'approved.example';
  const db = fakeDb();
  assert.equal((await ingestSupplierBatch(db, [{ ...entry, evidenceText: 'Supplier offers unspecified item' }], { dryRun: false, batchId: 'e' }))[0].status, 'needs_review');
  assert.equal((await ingestSupplierBatch(fakeDb({ policy: false }), [entry], { dryRun: false, batchId: 'f' }))[0].reason, 'source_policy_missing');
  assert.equal((await ingestSupplierBatch(db, [{ ...entry, sourceUseApproved: false, publicationApproved: false }], { dryRun: false, batchId: 'g' }))[0].status, 'inserted');
  assert.equal(db.calls.filter(sql => sql.includes('INSERT INTO public.supplier_product_relationships')).length, 1);
});
