import { pool } from "../config/db.js";

const claimsSql = `WITH claims AS (
 SELECT c.id,c.entity_id::text AS target_id,'company'::text AS claim_type,
   e.company_name AS target_name,e.nexaport_company_id AS reference,u.full_name AS claimant_name,
   c.status,c.created_at,c.evidence_s3_key IS NOT NULL AS has_evidence
 FROM maritime_company_claims c JOIN maritime_directory_entities e ON e.id=c.entity_id
 JOIN users u ON u.id=c.claimant_user_id
 UNION ALL
 SELECT c.id,c.source_id AS target_id,'professional'::text AS claim_type,
   CASE c.source_type
     WHEN 'expert' THEN (SELECT full_name FROM experts WHERE id::text=c.source_id)
     WHEN 'flag_inspector' THEN (SELECT full_name FROM flag_inspectors WHERE id::text=c.source_id)
     WHEN 'accredited_inspector' THEN (SELECT full_name FROM accredited_inspectors WHERE id::text=c.source_id)
     WHEN 'appointed_surveyor' THEN (SELECT full_name FROM appointed_ship_surveyors WHERE id::text=c.source_id)
   END AS target_name,
   CASE c.source_type
     WHEN 'expert' THEN (SELECT COALESCE(nexaport_id,public_id) FROM experts WHERE id::text=c.source_id)
     WHEN 'flag_inspector' THEN (SELECT public_id FROM flag_inspectors WHERE id::text=c.source_id)
     WHEN 'accredited_inspector' THEN (SELECT public_id FROM accredited_inspectors WHERE id::text=c.source_id)
     WHEN 'appointed_surveyor' THEN (SELECT public_id FROM appointed_ship_surveyors WHERE id::text=c.source_id)
   END AS reference,u.full_name AS claimant_name,c.status,c.created_at,
   c.evidence_s3_key IS NOT NULL AS has_evidence
 FROM professional_claims c JOIN users u ON u.id=c.claimant_user_id
) , scoped AS (
 SELECT * FROM claims WHERE ($1='all' OR claim_type=$1)
   AND ($3='' OR target_name ILIKE '%'||$3||'%' OR claimant_name ILIKE '%'||$3||'%' OR reference ILIKE '%'||$3||'%')
), filtered AS (
 SELECT * FROM scoped WHERE ($2='all' OR status=$2)
)`;

export async function listAdminProfileClaims(input={},db=pool) {
  const type=String(input.type||"all"),status=String(input.status||"pending"),q=String(input.q||"").trim();
  if(!["all","company","professional"].includes(type) || !["all","pending","approved","rejected","disputed"].includes(status) || q.length>120)
    throw Object.assign(new Error("Invalid claim filters."),{status:400,code:"INVALID_FILTER"});
  const page=Math.max(1,Math.min(100000,Number.parseInt(input.page,10)||1));
  const limit=25,params=[type,status,q];
  const [summary,items]=await Promise.all([
    db.query(`${claimsSql} SELECT count(*) FILTER (WHERE $2='all' OR status=$2)::int AS total,
      count(*) FILTER (WHERE status='pending')::int AS pending,
      count(*) FILTER (WHERE status='approved')::int AS approved,
      count(*) FILTER (WHERE status='rejected')::int AS rejected,
      count(*) FILTER (WHERE status='disputed')::int AS disputed,
      (SELECT count(*)::int FROM maritime_directory_entities WHERE nexaport_company_id IS NULL) AS missing_company_ids FROM scoped`,params),
    db.query(`${claimsSql} SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5`,[...params,limit,(page-1)*limit]),
  ]);
  return {data:items.rows,summary:summary.rows[0],page,limit,pages:Math.ceil(summary.rows[0].total/limit)};
}
