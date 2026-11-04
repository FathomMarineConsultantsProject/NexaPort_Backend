import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pool } from '../config/db.js';
import { ingestSupplierBatch } from '../services/supplierCatalogueIngestService.js';

const router = Router();
function authorized(req, res, next) {
  const expected = process.env.SUPPLIER_CATALOGUE_INTERNAL_TOKEN;
  const actual = req.headers.authorization?.replace(/^Bearer /, '') || '';
  if (!expected || !actual || Buffer.byteLength(expected) !== Buffer.byteLength(actual) || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) return res.status(401).json({ error: 'unauthorized' });
  next();
}
router.use(authorized);
router.post('/ingest', async (req, res) => {
  const { entries, batchId, dryRun = true } = req.body || {};
  if (!Array.isArray(entries) || !entries.length || entries.length > 100 || typeof batchId !== 'string' || batchId.length > 120) return res.status(400).json({ error: 'invalid_batch' });
  const localWrites = process.env.SUPPLIER_CATALOGUE_LOCAL_WRITES === 'true' && ['localhost', '127.0.0.1'].includes(process.env.DB_HOST) && process.env.DB_NAME === 'shipserv_test';
  const productionWrites = process.env.SUPPLIER_CATALOGUE_PRODUCTION_WRITES === 'true' && process.env.DB_NAME === 'nexaportdb' && !['localhost', '127.0.0.1'].includes(process.env.DB_HOST);
  if (dryRun === false && !localWrites && !productionWrites) return res.status(403).json({ error: 'catalogue_writes_disabled' });
  const results = await ingestSupplierBatch(pool, entries, { dryRun: dryRun !== false, batchId });
  res.json({ batchId, dryRun: dryRun !== false, results });
});
router.get('/status', async (_req, res) => {
  let worker = { status: 'not_started' };
  try {
    const path = new URL('../../../tools/impa_product_catalogue/output/supplier_pipeline/state.json', import.meta.url);
    worker = JSON.parse(await readFile(path, 'utf8'));
    if (worker.status === 'running' || worker.status === 'paused') {
      try {
        const pid = Number(await readFile(new URL('../../../tools/impa_product_catalogue/output/supplier_pipeline/worker.pid', import.meta.url), 'utf8'));
        process.kill(pid, 0);
      } catch { worker = { ...worker, status: 'interrupted', last_error: 'worker process is absent' }; }
    }
  } catch (error) { if (error.code !== 'ENOENT') worker = { status: 'status_unavailable' }; }
  try {
    const { rows } = await pool.query(`SELECT (SELECT count(*)::int FROM public.catalog_products) AS products, (SELECT count(*)::int FROM public.catalog_suppliers) AS suppliers, (SELECT count(*)::int FROM public.supplier_product_relationships WHERE review_status='reviewed_verified') AS reviewed_relationships, (SELECT count(*)::int FROM public.catalog_products p WHERE NOT EXISTS (SELECT 1 FROM public.supplier_product_relationships r WHERE r.product_id=p.id AND r.review_status IN ('reviewed_verified','accepted_local_extraction'))) AS products_without_verified_supplier`);
    const installed = (await pool.query("SELECT to_regclass('public.supplier_catalogue_observations') IS NOT NULL AS ready")).rows[0].ready;
    const reviews = installed ? (await pool.query("SELECT count(*)::int AS pending FROM public.supplier_catalogue_observations WHERE result_status IN ('needs_review','unknown_product','rejected','failed')")).rows[0].pending : null;
    const policiesInstalled = (await pool.query("SELECT to_regclass('public.supplier_catalogue_source_policies') IS NOT NULL AS ready")).rows[0].ready;
    const policies = policiesInstalled ? (await pool.query(`SELECT count(*)::int AS recorded,
      count(*) FILTER (WHERE supplier_identity_status='verified' AND offering_confirmation_status='documented'
        AND offering_scope <> 'unknown' AND publication_rights_status='documented'
        AND publication_rights_scope='commercial_publication')::int AS publication_ready
      FROM public.supplier_catalogue_source_policies`)).rows[0] : { recorded: 0, publication_ready: 0 };
    const scope = process.env.DB_NAME === 'shipserv_test' && ['127.0.0.1', 'localhost'].includes(process.env.DB_HOST)
      ? 'isolated_test' : process.env.DB_NAME === 'nexaportdb' && !['127.0.0.1', 'localhost'].includes(process.env.DB_HOST)
        ? 'production' : 'unverified';
    res.json({ database: { ...rows[0], pending_review: reviews, source_policies: policies, scope }, worker, scheduler: { status: 'not_configured' } });
  } catch (error) { res.status(503).json({ database: { status: 'unavailable', code: error.code || 'database_error' }, worker, scheduler: { status: 'not_configured' } }); }
});
export default router;
