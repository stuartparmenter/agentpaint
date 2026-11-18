// Columns added to tables after they were first written. Each is added to an
// existing table with values that fit the rows already there.

function addColumn(sql: SqlStorage, table: string, column: string, definition: string, fill?: string) {
  const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?)", table).toArray();
  if (columns.length && !columns.some((c) => c.name === column)) {
    sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    if (fill) sql.exec(fill);
  }
}

/** allow_finish, set to what earlier paintings allowed: the agent could end them early. */
export function addAllowFinishColumn(sql: SqlStorage, table: "paintings" | "meta") {
  addColumn(sql, table, "allow_finish", "INTEGER NOT NULL DEFAULT 1");
}

/**
 * tokens.start_version, the stroke count when the assignment was handed out. For
 * an existing token it is the token's version less the strokes painted on its
 * assignment (each assignment has one token).
 */
export function addStartVersionColumn(sql: SqlStorage) {
  addColumn(
    sql,
    "tokens",
    "start_version",
    "INTEGER NOT NULL DEFAULT 0",
    `UPDATE tokens SET start_version = version -
       (SELECT COUNT(*) FROM strokes WHERE strokes.assignment = tokens.assignment)`,
  );
}
