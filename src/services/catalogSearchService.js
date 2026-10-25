import { pool } from '../config/db.js';

export async function searchCatalog(query, db=pool, page=1) {
  const q=String(query||'').trim().slice(0,120);
  if (!q) return {rows:[],pagination:{page,total:0,pages:0},relatedSources:[],relatedPagination:{page,total:0,pages:0}};
  const namespace=/^(IMPA|MODEL|PART|SKU)\s+(.+)$/i.exec(q);
  const normalized=(namespace?.[2]||q).toUpperCase().replace(/\s+/g,'');
  const namespaceFilter=namespace?.[1]?.toUpperCase()||null;
  const result=await db.query(`WITH hits AS (SELECT p.id,
    CASE WHEN EXISTS(SELECT 1 FROM public.product_identifiers x WHERE x.product_id=p.id AND x.display_value=$5 AND ($4::text IS NULL OR x.namespace=$4)) THEN 0
         WHEN EXISTS(SELECT 1 FROM public.product_identifiers x WHERE x.product_id=p.id AND x.normalized_value=$2 AND ($4::text IS NULL OR x.namespace=$4)) THEN 1
         WHEN lower(p.name)=lower($1) THEN 2 ELSE 3 END AS rank
    FROM public.catalog_products p
    WHERE EXISTS(SELECT 1 FROM public.product_identifiers x WHERE x.product_id=p.id AND x.normalized_value=$2 AND ($4::text IS NULL OR x.namespace=$4))
       OR EXISTS(SELECT 1 FROM public.product_identifiers x WHERE x.product_id=p.id AND lower(coalesce(p.manufacturer,'')||' '||x.display_value)=lower($1))
       OR p.source_key=$1 OR lower(p.name) LIKE lower($1)||'%')
    SELECT p.id,p.source_namespace,p.source_key,p.name,p.canonical_url,p.uom,COUNT(*) OVER()::int AS total_matches,
    array_agg(DISTINCT i.display_value) FILTER (WHERE i.id IS NOT NULL) AS identifiers,(h.rank<=1) AS exact_match
    FROM hits h JOIN public.catalog_products p ON p.id=h.id LEFT JOIN public.product_identifiers i ON i.product_id=p.id
    GROUP BY p.id,h.rank ORDER BY h.rank,p.name,p.id LIMIT 50 OFFSET $3`,[q,normalized,(page-1)*50,namespaceFilter,namespace?.[2]||q]);
  const total=result.rows[0]?.total_matches||0;
  const related=await db.query(`SELECT m.id,m.namespace,m.display_identifier,m.source_url,m.page_number,m.evidence_text,m.evidence_state,
    s.name AS supplier_name,s.profile_url AS supplier_profile_url,s.location AS supplier_location,count(*) OVER()::int AS total_matches
    FROM public.catalog_candidate_source_mentions m JOIN public.catalog_suppliers s ON s.id=m.supplier_id
    WHERE m.normalized_identifier=$1 AND m.evidence_state='document_host_only'
    ORDER BY s.name,m.source_url,m.page_number,m.id LIMIT 20 OFFSET $2`,[normalized,(page-1)*20]);
  const relatedTotal=related.rows[0]?.total_matches||0;
  return {rows:result.rows,pagination:{page,total,pages:Math.ceil(total/50)},relatedSources:related.rows,
    relatedPagination:{page,total:relatedTotal,pages:Math.ceil(relatedTotal/20)}};
}

export async function getCatalogProduct(id,{page=1,limit=25}={},db=pool) {
  const product=(await db.query('SELECT * FROM public.catalog_products WHERE id=$1',[id])).rows[0];
  if (!product) return null;
  const identifiers=await db.query('SELECT namespace,display_value,manufacturer_context,evidence_url,page_number FROM public.product_identifiers WHERE product_id=$1 ORDER BY namespace,display_value',[id]);
  const categories=await db.query('SELECT c.name,c.path,c.source_url FROM public.product_categories c JOIN public.catalog_product_categories pc ON pc.category_id=c.id WHERE pc.product_id=$1 ORDER BY c.path',[id]);
  const sourceSuppliers=await db.query(`SELECT s.id,s.source_key,s.tnid,s.name,s.profile_url,s.country,s.location,
      e.id AS canonical_entity_id,e.company_name AS canonical_company_name,e.nexaport_company_id,e.public_id,
      e.city AS canonical_city,e.country AS canonical_country,e.public_email,e.public_phone,e.website,
      (SELECT jsonb_agg(jsonb_build_object('type',r.relationship_type,'evidenceClassification',r.evidence_classification,
        'evidenceUrl',r.evidence_url,'evidencePage',r.page_number,'evidenceText',r.evidence_text,
        'reviewStatus',r.review_status,'verifiedStockStatus',r.verified_stock_status) ORDER BY r.id)
       FROM public.supplier_product_relationships r WHERE r.product_id=$1 AND r.supplier_id=s.id
         AND r.relationship_type IN ('supplier_listing','verified_offer')
         AND r.review_status IN ('accepted_local_extraction','reviewed_verified')) AS relationships
      FROM public.catalog_suppliers s
      JOIN public.supplier_product_relationships offering ON offering.supplier_id=s.id AND offering.product_id=$1
        AND offering.relationship_type IN ('supplier_listing','verified_offer')
        AND offering.review_status IN ('accepted_local_extraction','reviewed_verified')
      LEFT JOIN LATERAL (SELECT min(src.entity_id::text)::uuid AS entity_id FROM public.directory_entity_sources src
        WHERE src.source_name='ShipServ' AND
          (src.source_url=s.profile_url OR (s.tnid IS NOT NULL AND s.tnid<>'208652' AND src.source_external_id=s.tnid))
        HAVING count(DISTINCT src.entity_id)=1) verified ON true
      LEFT JOIN public.maritime_directory_entities e ON e.id=verified.entity_id
        AND e.is_active=true AND e.review_status='approved'
        AND EXISTS(SELECT 1 FROM public.maritime_directory_entity_types t WHERE t.entity_id=e.id AND t.directory_type='supplier')
      GROUP BY s.id,e.id ORDER BY s.name,s.id`,[id]);
  const listed=sourceSuppliers.rows;
  const qualifying=new Set(['supplier_catalogue_listing','supplier_catalogue_part','explicit_brochure_offer','reviewed_self_branded_offer']);
  const hasListing=row=>row.relationships?.some(relationship=>qualifying.has(relationship.evidenceClassification));
  const offerings=listed.filter(hasListing);
  const matched=offerings.filter(row=>row.canonical_entity_id);
  return {...product,identifiers:identifiers.rows,categories:categories.rows,
    supplierCount:matched.length,sourceSupplierCount:offerings.length,
    suppliers:matched.slice((page-1)*limit,page*limit),sourceSuppliers:offerings.filter(row=>!row.canonical_entity_id),
    relatedProductSources:listed.filter(row=>!hasListing(row)),
    pagination:{page,limit,total:matched.length,pages:Math.ceil(matched.length/limit)}};
}
