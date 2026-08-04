/**
 * Audits stored strategy artifacts for programs the compiler rejects.
 *
 * Before the analyze gate started blocking, a `ready` artifact could be
 * persisted without ever being verified: when the backtest service was
 * unreachable, analyze fell back to substring structural checks and banked the
 * row anyway. A model that emitted a different program dialect therefore
 * produced strategies the customer could confirm but never run — every backtest
 * came back COMPILE_FAILED against a row that looked healthy.
 *
 * This walks the D1 sqlite file, compiles each stored source, and reports the
 * rows that cannot run. `--apply` archives them, which is the existing way to
 * take a row out of circulation (`ownedStrategy` filters `archived_at IS NULL`)
 * and is reversible by clearing the column again.
 *
 *   npx tsx scripts/audit-strategy-sources.ts <path-to-d1.sqlite>
 *   npx tsx scripts/audit-strategy-sources.ts <path-to-d1.sqlite> --apply
 */
import { DatabaseSync } from "node:sqlite";

import { compileStrategySource, StrategyCompilationError } from "../src/compiler/compile-strategy-source.js";

interface SubmissionRow {
  id: string;
  status: string;
  confirmed_at: string | null;
  archived_at: string | null;
  result_json: string;
}

interface Finding {
  id: string;
  confirmed: boolean;
  reason: string;
}

function inspect(row: SubmissionRow): Finding | null {
  let artifact: Record<string, unknown>;
  try {
    artifact = JSON.parse(row.result_json) as Record<string, unknown>;
  } catch {
    return { id: row.id, confirmed: row.confirmed_at !== null, reason: "result_json is not valid JSON" };
  }
  if (artifact.status !== "ready") return null;
  const source = typeof artifact.source === "string" ? artifact.source : "";
  if (source === "") {
    return { id: row.id, confirmed: row.confirmed_at !== null, reason: "ready artifact stores no program" };
  }
  try {
    compileStrategySource(source);
    return null;
  } catch (error) {
    const reason = error instanceof StrategyCompilationError
      ? error.diagnostics.map((item) => `${item.code}: ${item.message}`).join(" / ")
      : error instanceof Error ? error.message : String(error);
    return { id: row.id, confirmed: row.confirmed_at !== null, reason };
  }
}

function main(): void {
  const [databasePath, ...flags] = process.argv.slice(2);
  if (!databasePath) {
    console.error("Usage: tsx scripts/audit-strategy-sources.ts <path-to-d1.sqlite> [--apply]");
    process.exit(1);
  }
  const apply = flags.includes("--apply");
  const database = new DatabaseSync(databasePath);
  const rows = database
    .prepare("SELECT id, status, confirmed_at, archived_at, result_json FROM strategy_submissions WHERE archived_at IS NULL")
    .all() as unknown as SubmissionRow[];

  const findings = rows.map(inspect).filter((finding): finding is Finding => finding !== null);
  console.log(`Scanned ${rows.length} live submissions; ${findings.length} cannot run.`);
  for (const finding of findings) {
    console.log(`  ${finding.id}${finding.confirmed ? " (confirmed)" : ""}\n    ${finding.reason}`);
  }
  if (findings.length === 0) return;

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to archive these rows.");
    return;
  }
  const archive = database.prepare("UPDATE strategy_submissions SET archived_at = ? WHERE id = ?");
  const now = new Date().toISOString();
  for (const finding of findings) archive.run(now, finding.id);
  console.log(`\nArchived ${findings.length} rows at ${now}.`);
}

main();
