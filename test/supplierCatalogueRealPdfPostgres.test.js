import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { ingestSupplierBatch } from '../src/services/supplierCatalogueIngestService.js';

const url = process.env.SUPPLIER_TEST_DATABASE_URL;
test('saved official Everlux catalogue through isolated PostgreSQL gate', { skip: !url }, async () => {
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/shipserv_test');
  assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname));
  const source = await readFile(new URL('../../tools/impa_product_catalogue/output/targeted_supplier_pilot/everlux_official_pdf_extracted.jsonl', import.meta.url), 'utf8');
  const record = source.split(/\r?\n/).filter(Boolean).map(JSON.parse).find(x => x.classification === 'REVIEW_OFFICIAL_CATALOGUE_ITEM');
  assert.ok(record);
  const pool = new pg.Pool({ connectionString: url, ssl: false });
  try {
    const installed = (await pool.query("SELECT to_regclass('public.catalog_products') IS NOT NULL AS ready")).rows[0].ready;
    if (!installed) for (const file of ['test/fixtures/supplier_pipeline_base.sql', 'sql/impa_product_catalogue/001_schema.sql', 'sql/impa_product_catalogue/004_shipserv_pdf.sql', 'sql/impa_product_catalogue/005_code_first_integration.sql']) {
      await pool.query(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
    }
    await pool.query(await readFile(new URL('../sql/impa_product_catalogue/006_supplier_pipeline.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../sql/impa_product_catalogue/007_supplier_observation_provenance.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../sql/supplier_catalogue_source_policies.sql', import.meta.url), 'utf8'));
    const entity = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const supplier = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const product = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await pool.query("DELETE FROM public.supplier_catalogue_observations WHERE batch_id IN ('real-pdf-review','real-pdf-test-approval','real-pdf-test-repeat')");
    await pool.query("DELETE FROM public.supplier_catalogue_source_policies WHERE external_source_name='official_website' AND external_source_id='www.everlux.com' AND source_url=$1 AND document_sha256=$2", [record.source_url, record.document_sha256]);
    await pool.query('DELETE FROM public.catalog_relationship_evidence WHERE relationship_id IN (SELECT id FROM public.supplier_product_relationships WHERE supplier_id=$1)', [supplier]);
    await pool.query('DELETE FROM public.supplier_product_relationships WHERE supplier_id=$1', [supplier]);
    await pool.query('DELETE FROM public.catalog_products WHERE id=$1', [product]);
    await pool.query('DELETE FROM public.catalog_suppliers WHERE id=$1', [supplier]);
    await pool.query('DELETE FROM public.directory_entity_sources WHERE entity_id=$1', [entity]);
    await pool.query('DELETE FROM public.maritime_directory_entity_types WHERE entity_id=$1', [entity]);
    await pool.query('DELETE FROM public.maritime_directory_entities WHERE id=$1', [entity]);
    const baseline = (await pool.query('SELECT count(*)::int AS n FROM public.supplier_product_relationships')).rows[0].n;
    await pool.query("INSERT INTO public.maritime_directory_entities(id,nexaport_company_id,review_status,is_active) VALUES($1,'NXP-0001695','approved',true)", [entity]);
    await pool.query("INSERT INTO public.maritime_directory_entity_types(entity_id,directory_type) VALUES($1,'supplier')", [entity]);
    await pool.query("INSERT INTO public.directory_entity_sources(entity_id,source_name,source_external_id,source_url) VALUES($1,'official_website','www.everlux.com',$2)", [entity, record.source_url]);
    await pool.query("INSERT INTO public.catalog_suppliers(id,source_namespace,source_key,name,profile_url,canonical_entity_id) VALUES($1,'test','everlux','Everlux',$2,$3)", [supplier, record.source_url, entity]);
    await pool.query("INSERT INTO public.catalog_products(id,source_namespace,source_key,canonical_url,name,impa_code) VALUES($1,'test',$2,$3,$4,$2)", [product, record.impa_code, record.source_url, record.canonical_name]);
    process.env.SUPPLIER_CATALOGUE_APPROVED_HOSTS = 'www.everlux.com';
    const base = { nexaportCompanyId: record.nexaport_company_id, externalSourceName: 'official_website', externalSourceId: 'www.everlux.com', impaCode: record.impa_code, sourceUrl: record.source_url, evidenceText: record.evidence_excerpt, supplierSku: record.supplier_sku, pageNumber: Number(record.page_number), documentSha256: record.document_sha256, extractedAt: record.retrieved_at, extractionMethod: 'everlux_saved_catalogue:official_pdf_crossref_v1', explicitOffer: true, sourceUseApproved: false, publicationApproved: false };
    const review = (await ingestSupplierBatch(pool, [base], { dryRun: false, batchId: 'real-pdf-review' }))[0];
    assert.equal(review.status, 'needs_review');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.supplier_product_relationships')).rows[0].n, baseline);
    // This source-level policy exists only in the isolated test fixture.
    await pool.query(`INSERT INTO public.supplier_catalogue_source_policies (nexaport_company_id,external_source_name,external_source_id,source_url,document_sha256,supplier_identity_status,supplier_identity_evidence,offering_confirmation_status,offering_scope,offering_evidence,internal_authorization_status,internal_authorization_evidence,publication_rights_status,publication_rights_evidence,publication_rights_scope,approved_host) VALUES ($1,'official_website','www.everlux.com',$2,$3,'verified','isolated fixture identity','documented','all_catalogue_rows','isolated fixture offering scope','documented','isolated fixture internal authorization','documented','isolated fixture publication rights','commercial_publication','www.everlux.com')`, [record.nexaport_company_id,record.source_url,record.document_sha256]);
    const approved = { ...base };
    const inserted = (await ingestSupplierBatch(pool, [approved], { dryRun: false, batchId: 'real-pdf-test-approval' }))[0];
    assert.equal(inserted.status, 'inserted');
    const duplicate = (await ingestSupplierBatch(pool, [approved], { dryRun: false, batchId: 'real-pdf-test-repeat' }))[0];
    assert.equal(duplicate.status, 'already_exists');
    const rows = (await pool.query('SELECT r.id,p.impa_code,r.supplier_part_number,r.evidence_url FROM public.supplier_product_relationships r JOIN public.catalog_products p ON p.id=r.product_id WHERE r.supplier_id=$1', [supplier])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].impa_code, record.impa_code);
    assert.equal(rows[0].supplier_part_number, record.supplier_sku);
    assert.equal(rows[0].evidence_url, record.source_url);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.catalog_relationship_evidence WHERE relationship_id=$1', [rows[0].id])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.supplier_product_relationships')).rows[0].n, baseline + 1);
  } finally { await pool.end(); }
});
