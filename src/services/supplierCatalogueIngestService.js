import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const sourcePolicyBlocker = policy => {
  if (!policy) return 'source_policy_missing';
  if (policy.supplier_identity_status !== 'verified' || (!policy.nexaport_company_id && !policy.verified_supplier_id) || !policy.supplier_identity_evidence) return 'source_supplier_identity_unresolved';
  if (policy.offering_confirmation_status !== 'documented' || !policy.offering_evidence || policy.offering_scope === 'unknown') return 'source_offering_scope_unverified';
  if (!['reported', 'documented'].includes(policy.internal_authorization_status) || !policy.internal_authorization_evidence) return 'internal_authorization_missing';
  if (policy.publication_rights_status !== 'documented' || !policy.publication_rights_evidence || policy.publication_rights_scope !== 'commercial_publication') return 'source_publication_rights_missing';
  if (!policy.approved_host || new URL(policy.source_url).hostname.toLowerCase() !== policy.approved_host.toLowerCase()) return 'source_host_unapproved';
  return null;
};
export const normalizeImpa = value => {
  const code = String(value ?? '').replace(/^IMPA\s*/i, '').replace(/[\s-]/g, '');
  return /^\d{6}$/.test(code) ? code : null;
};

export async function ingestSupplierBatch(db, entries, { dryRun = true, batchId } = {}) {
  const results = [];
  for (let index = 0; index < entries.length; index++) {
    const row = entries[index];
    const result = { index, impaCode: normalizeImpa(row.impaCode) };
    const client = await db.connect();
    let resolvedSupplierId = null;
    let resolvedPolicy = null;
    try {
      await client.query('BEGIN');
      const code = result.impaCode;
      if (!code || (!row.nexaportCompanyId && !row.supplierId) || !row.externalSourceName || !row.externalSourceId || !/^https:\/\//i.test(String(row.sourceUrl || '')) || typeof row.evidenceText !== 'string' || !row.evidenceText.trim() || row.evidenceText.length > 4000 || !/^[0-9a-f]{64}$/i.test(String(row.documentSha256 || '')) || !Number.isFinite(Date.parse(row.extractedAt)) || typeof row.extractionMethod !== 'string' || !batchId) {
        Object.assign(result, { status: 'rejected', reason: 'missing_or_invalid_required_fields' });
      } else if (row.supplierId && !/^[0-9a-f-]{36}$/i.test(String(row.supplierId))) {
        Object.assign(result, { status: 'rejected', reason: 'invalid_supplier_id' });
      } else {
        const policies = (await client.query(`SELECT * FROM public.supplier_catalogue_source_policies WHERE external_source_name=$1 AND external_source_id=$2 AND source_url=$3 AND document_sha256=$4 AND nexaport_company_id IS NOT DISTINCT FROM $5 AND (verified_supplier_id IS NULL OR verified_supplier_id=$6) LIMIT 2`, [row.externalSourceName,row.externalSourceId,row.sourceUrl,row.documentSha256,row.nexaportCompanyId || null,row.supplierId || null])).rows;
        const policy = policies.length === 1 ? policies[0] : null;
        resolvedPolicy = policy;
        const blocker = sourcePolicyBlocker(policy);
        if (blocker) Object.assign(result, { status: 'needs_review', reason: blocker });
        else if (!new RegExp(`\\b${code}\\b`).test(row.evidenceText.replace(/IMPA[\s:-]*/ig, '')) || (policy.offering_scope !== 'all_catalogue_rows' && row.explicitOffer !== true)) Object.assign(result, { status: 'needs_review', reason: 'offer_evidence_not_explicit' });
        else {
        const products = (await client.query('SELECT id FROM public.catalog_products WHERE impa_code=$1 LIMIT 2', [code])).rows;
        if (products.length !== 1) Object.assign(result, { status: products.length ? 'needs_review' : 'unknown_product', reason: products.length ? 'ambiguous_product' : 'unknown_product' });
        else {
          const suppliers = policy.verified_supplier_id
            ? (await client.query(`SELECT id FROM public.catalog_suppliers WHERE id=$1 AND ($2 <> 'ShipServ' OR tnid=$3) LIMIT 2`, [policy.verified_supplier_id,row.externalSourceName,row.externalSourceId])).rows
            : (await client.query(`SELECT DISTINCT s.id FROM public.catalog_suppliers s JOIN public.directory_entity_sources src ON src.source_name=$1 AND src.source_external_id=$2 JOIN public.maritime_directory_entities e ON e.id=src.entity_id AND e.is_active=true AND e.review_status='approved' AND e.nexaport_company_id=$3 JOIN public.maritime_directory_entity_types t ON t.entity_id=e.id AND t.directory_type='supplier' WHERE (s.canonical_entity_id=e.id OR (src.source_url=s.profile_url AND src.source_name='ShipServ')) AND ($4::uuid IS NULL OR s.id=$4) LIMIT 2`, [row.externalSourceName, row.externalSourceId, row.nexaportCompanyId, row.supplierId || null])).rows;
          if (suppliers.length !== 1) Object.assign(result, { status: 'needs_review', reason: 'supplier_identity_unresolved_or_ambiguous' });
          else {
            const supplierId = suppliers[0].id;
            resolvedSupplierId = supplierId;
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [String(products[0].id), String(supplierId)]);
            const existing = (await client.query(`SELECT id,product_id FROM public.supplier_product_relationships
              WHERE supplier_id=$2 AND (product_id=$1 OR product_id IN
                (SELECT product_id FROM public.product_identifiers WHERE namespace='IMPA' AND normalized_value=$3))
              ORDER BY CASE WHEN product_id=$1 THEN 0 ELSE 1 END LIMIT 2`, [products[0].id, supplierId, code])).rows[0];
            if (existing && String(existing.product_id) !== String(products[0].id)) {
              Object.assign(result, { status: 'needs_review', reason: 'legacy_shadow_relationship_requires_reconciliation', relationshipId: existing.id });
            } else if (existing) {
              let evidenceAdded = false;
              if (!dryRun) {
                const evidence = await client.query(`INSERT INTO public.catalog_relationship_evidence (relationship_id,source_url,document_sha256,page_number,evidence_text,extraction_version) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING relationship_id`, [existing.id, row.sourceUrl, row.documentSha256, row.pageNumber ?? 0, row.evidenceText, row.extractionMethod]);
                evidenceAdded = evidence.rows.length > 0;
              }
              Object.assign(result, { status: evidenceAdded ? 'updated_evidence' : 'already_exists', relationshipId: existing.id });
            } else if (dryRun) Object.assign(result, { status: 'inserted', dryRun: true });
            else {
              const inserted = (await client.query(`INSERT INTO public.supplier_product_relationships (product_id,supplier_id,relationship_type,evidence_url,evidence_text,review_status,evidence_classification,supplier_part_number,source_document_url,page_number,document_sha256,content_hash) VALUES ($1,$2,'supplier_listing',$3,$4,'reviewed_verified','supplier_catalogue_part',$5,$3,$6,$7,$8) ON CONFLICT (product_id,supplier_id,relationship_type,evidence_url) DO NOTHING RETURNING id`, [products[0].id, supplierId, row.sourceUrl, row.evidenceText, row.supplierSku ?? null, row.pageNumber ?? null, row.documentSha256, sha(`${batchId}:${index}:${row.evidenceText}`)])).rows[0];
              if (inserted) await client.query(`INSERT INTO public.catalog_relationship_evidence (relationship_id,source_url,document_sha256,page_number,evidence_text,extraction_version) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [inserted.id, row.sourceUrl, row.documentSha256, row.pageNumber ?? 0, row.evidenceText, row.extractionMethod]);
              Object.assign(result, { status: inserted ? 'inserted' : 'already_exists', relationshipId: inserted?.id });
            }
          }
        }
        }
      }
      if (!dryRun) await client.query(`INSERT INTO public.supplier_catalogue_observations (batch_id,batch_index,impa_code,supplier_id,source_url,evidence_text,source_document_sha256,extraction_method,extracted_at,result_status,reason,relationship_id,external_source_name,external_source_id,product_name,supplier_sku,page_number,cross_reference_page,source_claim_url,explicit_offer,source_use_approval_id,publication_approval_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) ON CONFLICT (batch_id,batch_index) DO UPDATE SET last_seen_at=now(),result_status=EXCLUDED.result_status,reason=EXCLUDED.reason,relationship_id=EXCLUDED.relationship_id,external_source_name=EXCLUDED.external_source_name,external_source_id=EXCLUDED.external_source_id,product_name=EXCLUDED.product_name,supplier_sku=EXCLUDED.supplier_sku,page_number=EXCLUDED.page_number,cross_reference_page=EXCLUDED.cross_reference_page,source_claim_url=EXCLUDED.source_claim_url,explicit_offer=EXCLUDED.explicit_offer,source_use_approval_id=EXCLUDED.source_use_approval_id,publication_approval_id=EXCLUDED.publication_approval_id`, [batchId,index,code,resolvedSupplierId || (/^[0-9a-f-]{36}$/i.test(String(row.supplierId || '')) ? row.supplierId : null),row.sourceUrl || null,typeof row.evidenceText === 'string' ? row.evidenceText.slice(0,4000) : null,row.documentSha256 || null,row.extractionMethod || null,Number.isFinite(Date.parse(row.extractedAt)) ? row.extractedAt : null,result.status,result.reason || null,result.relationshipId || null,row.externalSourceName || null,row.externalSourceId || null,row.productName || null,row.supplierSku || null,row.pageNumber ?? null,row.crossReferencePage ?? null,row.sourceClaimUrl || null,row.explicitOffer === true,resolvedPolicy?.id || null,resolvedPolicy?.id || null]);
      await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      Object.assign(result, { status: 'failed', reason: error.code || 'database_error' });
    } finally { client.release(); }
    results.push(result);
  }
  return results;
}
