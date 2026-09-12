export const mapInspectionCatalogue = (rows = []) => {
  const verticals = [];
  const byId = new Map();

  for (const row of rows) {
    const verticalId = Number(row.vertical_id);
    if (!byId.has(verticalId)) {
      const vertical = {
        id: verticalId,
        slug: row.vertical_slug,
        name: row.vertical_name,
        methods: [],
      };
      byId.set(verticalId, vertical);
      verticals.push(vertical);
    }

    if (row.method_id) {
      byId.get(verticalId).methods.push({
        id: Number(row.method_id),
        slug: row.method_slug,
        name: row.method_name,
      });
    }
  }

  return verticals;
};

export const getInspectionCatalogue = async (queryable) => {
  const result = await queryable.query(`
    SELECT
      v.id AS vertical_id,
      v.slug AS vertical_slug,
      v.name AS vertical_name,
      m.id AS method_id,
      m.slug AS method_slug,
      m.name AS method_name
    FROM inspection_verticals v
    LEFT JOIN inspection_methods m
      ON m.vertical_id = v.id
     AND m.is_active = TRUE
    WHERE v.is_active = TRUE
    ORDER BY v.display_order ASC, m.display_order ASC, m.name ASC
  `);

  return mapInspectionCatalogue(result.rows);
};

export const findInspectionMethod = async (queryable, inspectionMethodId) => {
  const methodId = Number(inspectionMethodId);
  if (!Number.isInteger(methodId) || methodId <= 0) return null;

  const result = await queryable.query(
    `
    SELECT
      m.id,
      m.slug,
      m.name,
      v.id AS vertical_id,
      v.slug AS vertical_slug,
      v.name AS vertical_name
    FROM inspection_methods m
    JOIN inspection_verticals v ON v.id = m.vertical_id
    WHERE m.id = $1
      AND m.is_active = TRUE
      AND v.is_active = TRUE
    LIMIT 1
    `,
    [methodId]
  );

  return result.rows[0] || null;
};
