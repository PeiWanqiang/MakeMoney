/**
 * Additive schema upgrades applied at runtime.
 *
 * The strategy and backtest APIs each create their own tables with
 * `CREATE TABLE IF NOT EXISTS`, which cannot introduce a column into a table that
 * already exists on a deployed database. SQLite has no `ADD COLUMN IF NOT EXISTS`,
 * so every column is checked against `PRAGMA table_info` before it is added.
 *
 * Matching Drizzle definitions live in `db/schema.ts` with a generated migration;
 * this module is what keeps an already-running deployment consistent.
 */

interface ColumnRow {
  name: string;
}

const OWNERSHIP_COLUMNS: Record<string, Array<{ name: string; definition: string }>> = {
  strategy_submissions: [
    { name: "user_id", definition: "TEXT" },
    { name: "title", definition: "TEXT" },
    { name: "confirmed_at", definition: "TEXT" },
    { name: "archived_at", definition: "TEXT" },
  ],
  backtest_runs: [{ name: "user_id", definition: "TEXT" }],
  optimization_runs: [{ name: "user_id", definition: "TEXT" }],
};

const OWNERSHIP_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_strategy_submissions_user ON strategy_submissions(user_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_backtest_runs_user ON backtest_runs(user_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_optimization_runs_user ON optimization_runs(user_id, created_at DESC)",
];

async function existingColumns(db: D1Database, table: string): Promise<Set<string>> {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<ColumnRow>();
  return new Set((result.results ?? []).map((row) => row.name));
}

/**
 * Adds ownership columns to whichever of the three tables already exist.
 * Safe to call repeatedly and safe to call before the tables are created — a
 * missing table simply has nothing to upgrade.
 */
export async function ensureOwnershipColumns(db: D1Database): Promise<void> {
  for (const [table, columns] of Object.entries(OWNERSHIP_COLUMNS)) {
    let present: Set<string>;
    try {
      present = await existingColumns(db, table);
    } catch {
      continue;
    }
    if (present.size === 0) continue; // Table does not exist yet; its CREATE will include the columns.
    for (const column of columns) {
      if (present.has(column.name)) continue;
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.definition}`).run()
        .catch(() => undefined); // A concurrent request may have added it first.
    }
  }
  for (const statement of OWNERSHIP_INDEXES) {
    await db.prepare(statement).run().catch(() => undefined);
  }
}
