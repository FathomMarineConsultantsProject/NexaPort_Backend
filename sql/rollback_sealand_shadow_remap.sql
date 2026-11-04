-- Manual emergency rollback, review batch_id before use. Never run as part of normal ingestion.
-- The remap log preserves old IDs; relationship IDs, statuses, and evidence are unchanged.
BEGIN;
UPDATE public.supplier_product_relationships r
SET product_id=log.old_product_id
FROM public.supplier_relationship_canonical_remap_log log
WHERE r.id=log.relationship_id
  AND r.product_id=log.new_product_id
  AND log.batch_id=:'batch_id'::uuid;
-- Inspect affected count before COMMIT; replace COMMIT with ROLLBACK if unexpected.
COMMIT;
