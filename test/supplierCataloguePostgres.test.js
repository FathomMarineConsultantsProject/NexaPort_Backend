import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { ingestSupplierBatch } from '../src/services/supplierCatalogueIngestService.js';

const url = process.env.SUPPLIER_TEST_DATABASE_URL;
test('isolated PostgreSQL catalogue ingestion and durable review', { skip: !url }, async () => {
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/shipserv_test', 'refusing a non-test database');
  assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname), 'refusing a remote database');
  const pool = new pg.Pool({ connectionString: url, ssl: false });
  try {
    const installed = (await pool.query("SELECT to_regclass('public.catalog_products') IS NOT NULL AS ready")).rows[0].ready;
    if (!installed) for (const file of ['test/fixtures/supplier_pipeline_base.sql', 'sql/impa_product_catalogue/001_schema.sql', 'sql/impa_product_catalogue/004_shipserv_pdf.sql', 'sql/impa_product_catalogue/005_code_first_integration.sql']) {
      await pool.query(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
    }
    for (const file of ['sql/impa_product_catalogue/006_supplier_pipeline.sql', 'sql/impa_product_catalogue/007_supplier_observation_provenance.sql']) await pool.query(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../sql/supplier_catalogue_source_policies.sql', import.meta.url), 'utf8'));
    const entity = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const supplier = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const product = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await pool.query("DELETE FROM public.supplier_catalogue_observations WHERE batch_id IN ('fixture-1','fixture-2','fixture-3')");
    await pool.query("DELETE FROM public.supplier_catalogue_source_policies WHERE external_source_name='ShipServ' AND external_source_id='test-1' AND source_url='https://approved.example/product'");
    await pool.query('DELETE FROM public.catalog_relationship_evidence WHERE relationship_id IN (SELECT id FROM public.supplier_product_relationships WHERE supplier_id=$1)', [supplier]);
    await pool.query('DELETE FROM public.supplier_product_relationships WHERE supplier_id=$1', [supplier]);
    await pool.query('DELETE FROM public.catalog_products WHERE id=$1', [product]);
    await pool.query('DELETE FROM public.catalog_suppliers WHERE id=$1', [supplier]);
    await pool.query('DELETE FROM public.directory_entity_sources WHERE entity_id=$1', [entity]);
    await pool.query('DELETE FROM public.maritime_directory_entity_types WHERE entity_id=$1', [entity]);
    await pool.query('DELETE FROM public.maritime_directory_entities WHERE id=$1', [entity]);
    const baseline = (await pool.query('SELECT count(*)::int AS n FROM public.supplier_product_relationships')).rows[0].n;
    await pool.query("INSERT INTO public.maritime_directory_entities(id,nexaport_company_id,review_status,is_active) VALUES($1,'NXP-TEST','approved',true)", [entity]);
    await pool.query("INSERT INTO public.maritime_directory_entity_types(entity_id,directory_type) VALUES($1,'supplier')", [entity]);
    await pool.query("INSERT INTO public.directory_entity_sources(entity_id,source_name,source_external_id,source_url) VALUES($1,'ShipServ','test-1','https://approved.example/supplier')", [entity]);
    await pool.query("INSERT INTO public.catalog_suppliers(id,source_namespace,source_key,tnid,name,profile_url,canonical_entity_id) VALUES($1,'test','test-1','test-1','Fixture Supplier','https://approved.example/supplier',$2)", [supplier, entity]);
    await pool.query("INSERT INTO public.catalog_products(id,source_namespace,source_key,canonical_url,name,impa_code) VALUES($1,'test','001234','https://approved.example/product','Fixture Product','001234')", [product]);
    process.env.SUPPLIER_CATALOGUE_APPROVED_HOSTS = 'approved.example';
    const row = { supplierId: supplier, nexaportCompanyId: 'NXP-TEST', externalSourceName: 'ShipServ', externalSourceId: 'test-1', impaCode: 'IMPA 001234', sourceUrl: 'https://approved.example/product', evidenceText: 'Fixture Supplier offers IMPA 001234 as SKU A', explicitOffer: true, documentSha256: 'a'.repeat(64), extractedAt: new Date().toISOString(), extractionMethod: 'fixture', sourceUseApproved: true, publicationApproved: true, sourceUseApprovalId: 'test-source-grant', publicationApprovalId: 'test-publication-grant' };
    await pool.query(`INSERT INTO public.supplier_catalogue_source_policies (nexaport_company_id,external_source_name,external_source_id,source_url,document_sha256,supplier_identity_status,supplier_identity_evidence,offering_confirmation_status,offering_scope,offering_evidence,internal_authorization_status,internal_authorization_evidence,publication_rights_status,publication_rights_evidence,publication_rights_scope,approved_host) VALUES ('NXP-TEST','ShipServ','test-1','https://approved.example/product',$1,'verified','fixture identity','documented','all_catalogue_rows','fixture offering','documented','fixture internal','documented','fixture publication','commercial_publication','approved.example')`, ['a'.repeat(64)]);
    assert.equal((await ingestSupplierBatch(pool, [row], { dryRun: false, batchId: 'fixture-1' }))[0].status, 'inserted');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.supplier_product_relationships')).rows[0].n, baseline + 1);
    assert.equal((await ingestSupplierBatch(pool, [row], { dryRun: false, batchId: 'fixture-2' }))[0].status, 'already_exists');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.supplier_product_relationships')).rows[0].n, baseline + 1);
    const bad = { ...row, impaCode: '999999', evidenceText: 'Fixture Supplier offers IMPA 999999' };
    assert.equal((await ingestSupplierBatch(pool, [bad], { dryRun: false, batchId: 'fixture-3' }))[0].status, 'unknown_product');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.supplier_catalogue_observations WHERE result_status='unknown_product'")).rows[0].n, 1);
  } finally { await pool.end(); }
});
