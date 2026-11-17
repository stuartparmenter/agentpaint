// Upgrades tables in Durable Object storage written by older versions of this code.

/**
 * Add the columns `table` is missing (`columns` maps name to its type and
 * default). Does nothing if the table doesn't exist.
 */
export function addMissingColumns(sql: SqlStorage, table: string, columns: Record<string, string>) {
  const existing = new Set(
    sql
      .exec<{ name: string }>("SELECT name FROM pragma_table_info(?)", table)
      .toArray()
      .map((r) => r.name),
  );
  if (existing.size === 0) return;
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}
