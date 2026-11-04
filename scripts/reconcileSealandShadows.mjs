/** Repoint exact Sealand shadow relationships to canonical IMPA products.
 *  Preserves relationship IDs, review status, evidence, and shadow products.
 *  Each 500-row transaction is logged for review and rollback.
 */
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const execute = process.argv.includes('--execute');
if (execute && !process.argv.includes('--production')) throw new Error('production mode required');
const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  if (!match || Object.hasOwn(env, match[1])) continue;
  const value = match[2].trim().replace(/^['"]|['"]$/g, '');
  if (!value.startsWith('[SENSITIVE]')) env[match[1]] = value;
}
if (env.DB_NAME !== 'nexaportdb' || ['localhost', '127.0.0.1'].includes(env.DB_HOST)) throw new Error('refusing non-production target');
const pool = new pg.Pool({ host: env.DB_HOST, port: Number(env.DB_PORT), database: env.DB_NAME,
  user: env.DB_USER, password: env.DB_PASSWORD, ssl: { rejectUnauthorized: false }, max: 1 });
const supplier = 'd7868b8f-25b2-d6d8-9113-a651559638c6';
const batchId = randomUUID();
const logFile = resolve('..', 'tools', 'impa_product_catalogue', 'output', 'supplier_pipeline', 'sealand_shadow_reconciliation.jsonl');
mkdirSync(dirname(logFile), { recursive: true });
const candidateSql = `SELECT r.id, r.product_id AS old_product_id, p.id AS new_product_id,
  x.normalized_value AS impa_code, r.review_status,
  EXISTS(SELECT 1 FROM public.supplier_product_relationships e
    WHERE e.supplier_id=r.supplier_id AND e.product_id=p.id) AS canonical_pair_exists
  FROM public.supplier_product_relationships r
  JOIN public.catalog_products shadow ON shadow.id=r.product_id AND shadow.impa_code IS NULL
  JOIN public.product_identifiers x ON x.product_id=shadow.id AND x.namespace='IMPA'
    AND x.normalized_value ~ '^[0-9]{6}$'
  JOIN public.catalog_products p ON p.impa_code=x.normalized_value
  LEFT JOIN public.supplier_relationship_canonical_remap_log log ON log.relationship_id=r.id
  WHERE r.supplier_id=$1 AND log.relationship_id IS NULL
  ORDER BY r.id LIMIT $2 FOR UPDATE OF r SKIP LOCKED`;

try {
  const preflight = await pool.query(`SELECT count(*)::int AS remaining FROM public.supplier_product_relationships r
    JOIN public.catalog_products p ON p.id=r.product_id WHERE r.supplier_id=$1 AND p.impa_code IS NULL`, [supplier]);
  if (!execute) { console.log(JSON.stringify({ mode: 'dry_run', remaining_shadows: preflight.rows[0].remaining })); process.exit(0); }
  await pool.query(`CREATE TABLE IF NOT EXISTS public.supplier_relationship_canonical_remap_log (
    relationship_id uuid PRIMARY KEY REFERENCES public.supplier_product_relationships(id),
    old_product_id uuid NOT NULL REFERENCES public.catalog_products(id),
    new_product_id uuid NOT NULL REFERENCES public.catalog_products(id),
    impa_code char(6) NOT NULL, old_review_status text NOT NULL,
    batch_id uuid NOT NULL, remapped_at timestamptz NOT NULL DEFAULT now())`);
  let total = 0;
  while (true) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('sealand-shadow-remap'))");
      const rows = (await client.query(candidateSql, [supplier, 500])).rows;
      if (!rows.length) { await client.query('COMMIT'); break; }
      if (rows.some(row => row.canonical_pair_exists)) throw new Error('canonical supplier-product pair conflict; batch rolled back');
      if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('ambiguous shadow mapping; batch rolled back');
      await client.query(`INSERT INTO public.supplier_relationship_canonical_remap_log
        (relationship_id,old_product_id,new_product_id,impa_code,old_review_status,batch_id)
        SELECT * FROM UNNEST($1::uuid[],$2::uuid[],$3::uuid[],$4::char(6)[],$5::text[],$6::uuid[])`,
        [rows.map(r => r.id), rows.map(r => r.old_product_id), rows.map(r => r.new_product_id),
         rows.map(r => r.impa_code), rows.map(r => r.review_status), rows.map(() => batchId)]);
      const updated = await client.query(`UPDATE public.supplier_product_relationships r SET product_id=log.new_product_id
        FROM public.supplier_relationship_canonical_remap_log log
        WHERE r.id=log.relationship_id AND r.product_id=log.old_product_id AND log.batch_id=$1`, [batchId]);
      if (updated.rowCount !== rows.length) throw new Error('remap count mismatch; batch rolled back');
      await client.query('COMMIT');
      total += updated.rowCount;
      const event = { at: new Date().toISOString(), batch_id: batchId, remapped: updated.rowCount, cumulative: total };
      appendFileSync(logFile, JSON.stringify(event) + '\n');
      console.log(JSON.stringify(event));
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  const result = await pool.query(`SELECT count(*)::int AS canonical_relationships,
    count(*) FILTER (WHERE r.review_status='reviewed_verified')::int AS reviewed_verified
    FROM public.supplier_product_relationships r JOIN public.catalog_products p ON p.id=r.product_id
    WHERE r.supplier_id=$1 AND p.impa_code IS NOT NULL`, [supplier]);
  console.log(JSON.stringify({ mode: 'complete', batch_id: batchId, remapped_this_run: total, ...result.rows[0] }));
} finally { await pool.end(); }
