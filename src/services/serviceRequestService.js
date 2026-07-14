const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

export const deleteServiceRequestById = async (client, requestId) => {
  const constraintsResult = await client.query(`
    SELECT
      con.conname AS constraint_name,
      child_ns.nspname AS child_schema,
      child.relname AS child_table,
      child_col.attname AS child_column,
      parent_col.attname AS parent_column,
      con.confdeltype AS delete_action,
      cardinality(con.conkey) AS column_count
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    JOIN pg_attribute child_col
      ON child_col.attrelid = con.conrelid AND child_col.attnum = con.conkey[1]
    JOIN pg_attribute parent_col
      ON parent_col.attrelid = con.confrelid AND parent_col.attnum = con.confkey[1]
    WHERE con.contype = 'f'
      AND parent_ns.nspname = 'public'
      AND parent.relname = 'service_requests'
    ORDER BY child_ns.nspname, child.relname, con.conname
  `);

  const cleanedDependencies = [];
  for (const constraint of constraintsResult.rows) {
    if (Number(constraint.column_count) !== 1) {
      const error = new Error(
        `Service request deletion is blocked by composite foreign key ${constraint.constraint_name}.`
      );
      error.status = 409;
      throw error;
    }

    if (!["a", "r"].includes(constraint.delete_action)) continue;

    const childTable = `${quoteIdentifier(constraint.child_schema)}.${quoteIdentifier(
      constraint.child_table
    )}`;
    const childColumn = quoteIdentifier(constraint.child_column);
    const parentColumn = quoteIdentifier(constraint.parent_column);
    const deleted = await client.query(
      `DELETE FROM ${childTable} WHERE ${childColumn} = (SELECT ${parentColumn} FROM public.service_requests WHERE id = $1)`,
      [requestId]
    );
    cleanedDependencies.push({
      table: `${constraint.child_schema}.${constraint.child_table}`,
      rowsDeleted: deleted.rowCount,
    });
  }

  const deletedRequest = await client.query(
    `DELETE FROM public.service_requests WHERE id = $1 RETURNING id`,
    [requestId]
  );

  return { deleted: Boolean(deletedRequest.rows.length), cleanedDependencies };
};
