// Tables written before the allow_finish column existed get it, set to what those
// paintings allowed: the agent could end them early.

export function addAllowFinishColumn(sql: SqlStorage, table: "paintings" | "meta") {
  const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?)", table).toArray();
  if (columns.length && !columns.some((c) => c.name === "allow_finish")) {
    sql.exec(`ALTER TABLE ${table} ADD COLUMN allow_finish INTEGER NOT NULL DEFAULT 1`);
  }
}
