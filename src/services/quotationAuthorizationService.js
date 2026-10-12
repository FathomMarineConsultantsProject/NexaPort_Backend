// Explicit Admin decisions and migration-only historical authorizations share
// the same revision gate. A legacy record never authorizes a newer revision.
export const getAuthorizedQuotationRevision = async (queryable, quotationId, revisionId) => {
  if (!revisionId) return null;
  return (await queryable.query(`
    SELECT r.* FROM quotation_revisions r
    LEFT JOIN quotation_revision_decisions d ON d.revision_id=r.id AND d.decision='approved'
    LEFT JOIN quotation_legacy_authorizations legacy ON legacy.revision_id=r.id
    WHERE r.id=$1 AND r.quotation_id=$2
      AND (d.id IS NOT NULL OR legacy.revision_id IS NOT NULL)`, [revisionId, quotationId])).rows[0] || null;
};
