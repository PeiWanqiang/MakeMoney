import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { emaFundingStrategy, emaTrendStrategy } from "../examples/strategies.js";
import type { BacktestConfig, BacktestResult, ClosedTrade, EquityPoint } from "../src/core/types.js";
import { aggregateOneMinuteBars, type AggregateInterval } from "../src/data/aggregate-bars.js";
import { loadHistoricalDataset } from "../src/data/historical-dataset.js";
import { runBacktest } from "../src/runtime/backtest.js";

interface ReferenceResult {
  referenceEngineVersion: string;
  initialCapital: number;
  finalEquity: number;
  returnPercent: number;
  trades: ClosedTrade[];
  equityCurve: EquityPoint[];
}

interface Mismatch {
  path: string;
  authoritative: unknown;
  reference: unknown;
  absoluteDifference?: number;
}

const config: BacktestConfig = {
  initialCapital: 10_000,
  takerFeeRate: 0.00045,
  slippageBps: 2,
  maxLeverage: 3,
};

const specs = {
  trend: {
    source: emaTrendStrategy,
    reference: {
      kind: "ema-trend",
      fastPeriod: 20,
      slowPeriod: 50,
      riskPercent: 0.01,
      stopLossPercent: 0.05,
    },
  },
  funding: {
    source: emaFundingStrategy,
    reference: {
      kind: "ema-negative-funding",
      fastPeriod: 3,
      slowPeriod: 5,
      riskPercent: 0.01,
      stopLossPercent: 0.02,
      takeProfitRiskReward: 2,
    },
  },
} as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runPython(script: string, input: string, output: string): Promise<void> {
  const child = spawn("python3", [script, input, output], { stdio: ["ignore", "ignore", "pipe"] });
  let errorOutput = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (errorOutput += chunk));
  const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", resolvePromise);
  });
  if (exitCode !== 0) throw new Error(`Python reference engine failed (${exitCode}): ${errorOutput.trim()}`);
}

const mismatches: Mismatch[] = [];
const maximumAbsoluteDifferences: Record<string, number> = {};
const absoluteTolerance = 1e-8;
const relativeTolerance = 1e-10;

function compareExact(path: string, authoritative: unknown, reference: unknown): void {
  if (authoritative !== reference && mismatches.length < 100) mismatches.push({ path, authoritative, reference });
}

function compareNumber(path: string, authoritative: number, reference: number, category: string): void {
  const absoluteDifference = Math.abs(authoritative - reference);
  maximumAbsoluteDifferences[category] = Math.max(maximumAbsoluteDifferences[category] ?? 0, absoluteDifference);
  const allowed = Math.max(absoluteTolerance, relativeTolerance * Math.max(Math.abs(authoritative), Math.abs(reference)));
  if ((!Number.isFinite(authoritative) || !Number.isFinite(reference) || absoluteDifference > allowed) && mismatches.length < 100) {
    mismatches.push({ path, authoritative, reference, absoluteDifference });
  }
}

function compareTrades(authoritative: ClosedTrade[], reference: ClosedTrade[]): void {
  compareExact("trades.length", authoritative.length, reference.length);
  const numericFields = [
    "entryPrice",
    "exitPrice",
    "quantity",
    "grossPnl",
    "fundingPnl",
    "fees",
    "slippageCost",
    "netPnl",
  ] as const;
  for (let index = 0; index < Math.min(authoritative.length, reference.length); index += 1) {
    const actual = authoritative[index];
    const expected = reference[index];
    if (!actual || !expected) continue;
    compareExact(`trades[${index}].side`, actual.side, expected.side);
    compareExact(`trades[${index}].entryTimestamp`, actual.entryTimestamp, expected.entryTimestamp);
    compareExact(`trades[${index}].exitTimestamp`, actual.exitTimestamp, expected.exitTimestamp);
    compareExact(`trades[${index}].exitReason`, actual.exitReason, expected.exitReason);
    for (const field of numericFields) {
      compareNumber(`trades[${index}].${field}`, actual[field], expected[field], `trade.${field}`);
    }
  }
}

function compareEquity(authoritative: EquityPoint[], reference: EquityPoint[]): void {
  compareExact("equityCurve.length", authoritative.length, reference.length);
  for (let index = 0; index < Math.min(authoritative.length, reference.length); index += 1) {
    const actual = authoritative[index];
    const expected = reference[index];
    if (!actual || !expected) continue;
    compareExact(`equityCurve[${index}].timestamp`, actual.timestamp, expected.timestamp);
    compareNumber(`equityCurve[${index}].equity`, actual.equity, expected.equity, "equity");
  }
}

const catalogArgument = process.argv[2] ?? "data/history/binance-usdm/BTCUSDT-PERP/1m/dataset.catalog.json";
const interval = (process.argv[3] ?? "4h") as AggregateInterval;
const strategyName = process.argv[4] ?? "funding";
if (!(["1m", "15m", "1h", "4h"] as string[]).includes(interval)) throw new Error(`Unsupported interval '${interval}'.`);
const spec = specs[strategyName as keyof typeof specs];
if (!spec) throw new Error(`Unsupported strategy '${strategyName}'. Use trend or funding.`);

const loaded = await loadHistoricalDataset(resolve(catalogArgument));
const aggregation = aggregateOneMinuteBars(loaded.bars, interval);
const authoritative = await runBacktest(spec.source, aggregation.bars, config);
const pythonPath = resolve("reference/python_reference_backtest.py");
const pythonSource = await readFile(pythonPath, "utf8");
const fixture = {
  schemaVersion: "1.0",
  datasetId: loaded.catalog.datasetId,
  interval,
  config,
  strategy: spec.reference,
  bars: aggregation.bars,
};
const fixtureJson = JSON.stringify(fixture);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "backtest-cross-validation-"));
let reference: ReferenceResult;
try {
  const inputPath = join(temporaryDirectory, "fixture.json");
  const outputPath = join(temporaryDirectory, "reference-result.json");
  await writeFile(inputPath, fixtureJson, "utf8");
  await runPython(pythonPath, inputPath, outputPath);
  reference = JSON.parse(await readFile(outputPath, "utf8")) as ReferenceResult;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

compareNumber("initialCapital", authoritative.initialCapital, reference.initialCapital, "initialCapital");
compareNumber("finalEquity", authoritative.finalEquity, reference.finalEquity, "finalEquity");
compareNumber("returnPercent", authoritative.returnPercent, reference.returnPercent, "returnPercent");
compareTrades(authoritative.trades, reference.trades);
compareEquity(authoritative.equityCurve, reference.equityCurve);

const resultSummary = (result: Pick<BacktestResult, "initialCapital" | "finalEquity" | "returnPercent" | "trades" | "equityCurve">) => ({
  initialCapital: result.initialCapital,
  finalEquity: result.finalEquity,
  returnPercent: result.returnPercent,
  trades: result.trades.length,
  equityPoints: result.equityCurve.length,
});
const reportIdentity = {
  schemaVersion: "1.0",
  authoritativeEngineVersion: "0.2.0",
  referenceEngineVersion: reference.referenceEngineVersion,
  pythonSourceSha256: sha256(pythonSource),
  fixtureSha256: sha256(fixtureJson),
  datasetId: loaded.catalog.datasetId,
  datasetPartitionHashes: loaded.catalog.partitions.map((partition) => partition.dataSha256),
  interval,
  strategyName,
  strategyProgramHash: authoritative.strategy.programHash,
  config,
};
const reportId = sha256(JSON.stringify(reportIdentity));
const report = {
  ...reportIdentity,
  reportId,
  status: mismatches.length === 0 ? "pass" : "fail",
  tolerances: { absolute: absoluteTolerance, relative: relativeTolerance },
  mismatchCount: mismatches.length,
  mismatches,
  maximumAbsoluteDifferences,
  authoritative: {
    ...resultSummary(authoritative),
    resultSha256: sha256(JSON.stringify(authoritative)),
  },
  reference: {
    ...resultSummary(reference),
    resultSha256: sha256(JSON.stringify(reference)),
  },
};
const reportDirectory = resolve("data/reports/cross-validation");
await mkdir(reportDirectory, { recursive: true });
const reportPath = join(reportDirectory, `${reportId}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ reportPath, ...report }, null, 2));
if (mismatches.length > 0) throw new Error(`Cross-validation failed with ${mismatches.length} recorded mismatches.`);
