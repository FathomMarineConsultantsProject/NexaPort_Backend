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

export const normalizeInspectionMethodIds = (inspectionMethodIds) => {
  if (inspectionMethodIds === undefined || inspectionMethodIds === null) return [];
  if (!Array.isArray(inspectionMethodIds)) {
    const error = new Error("inspectionMethodIds must be an array.");
    error.statusCode = 400;
    throw error;
  }

  const seen = new Set();
  const ids = [];
  for (const value of inspectionMethodIds) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
      const error = new Error("Inspection capabilities must contain valid method IDs.");
      error.statusCode = 400;
      throw error;
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
};

export const validateInspectionMethodIds = async (queryable, inspectionMethodIds) => {
  const ids = normalizeInspectionMethodIds(inspectionMethodIds);
  if (!ids.length) return [];

  const result = await queryable.query(
    `
    SELECT m.id
    FROM inspection_methods m
    JOIN inspection_verticals v ON v.id = m.vertical_id
    WHERE m.id = ANY($1::bigint[])
      AND m.is_active = TRUE
      AND v.is_active = TRUE
    `,
    [ids]
  );

  const activeIds = new Set(result.rows.map((row) => Number(row.id)));
  if (ids.some((id) => !activeIds.has(id))) {
    const error = new Error("Every selected inspection capability must exist and be active.");
    error.statusCode = 400;
    throw error;
  }

  return ids;
};

export const replaceExpertInspectionMethods = async (queryable, expertId, inspectionMethodIds) => {
  const ids = await validateInspectionMethodIds(queryable, inspectionMethodIds);
  await queryable.query(`DELETE FROM expert_inspection_methods WHERE expert_id = $1`, [expertId]);

  for (const methodId of ids) {
    await queryable.query(
      `
      INSERT INTO expert_inspection_methods (expert_id, inspection_method_id)
      VALUES ($1, $2)
      ON CONFLICT (expert_id, inspection_method_id) DO NOTHING
      `,
      [expertId, methodId]
    );
  }

  return ids;
};

export const getExpertInspectionCapabilities = async (queryable, expertId) => {
  const result = await queryable.query(
    `
    SELECT
      v.id AS vertical_id,
      v.slug AS vertical_slug,
      v.name AS vertical_name,
      m.id AS method_id,
      m.slug AS method_slug,
      m.name AS method_name
    FROM expert_inspection_methods eim
    JOIN inspection_methods m ON m.id = eim.inspection_method_id
    JOIN inspection_verticals v ON v.id = m.vertical_id
    WHERE eim.expert_id = $1
    ORDER BY v.display_order ASC, m.display_order ASC, m.name ASC
    `,
    [expertId]
  );

  return mapInspectionCatalogue(result.rows);
};
