import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { emaFundingStrategy, emaTrendStrategy } from "./strategies.js";
import { isTimeframe } from "../src/core/timeframes.js";
import { aggregateOneMinuteBars, type AggregateInterval } from "../src/data/aggregate-bars.js";
import { loadHistoricalDataset } from "../src/data/historical-dataset.js";
import { loadMarketSnapshot } from "../src/data/market-snapshot.js";
import { runBacktest } from "../src/runtime/backtest.js";
import { calculateBacktestMetrics } from "../src/runtime/backtest-metrics.js";

const manifestArgument = process.argv[2];
const interval = (process.argv[3] ?? "4h") as AggregateInterval;
const strategyName = process.argv[4] ?? "trend";
if (!manifestArgument) {
  throw new Error(
    "Usage: npm run backtest:real -- /absolute/path/to/snapshot.manifest.json-or-dataset.catalog.json [15m|1h|4h|1d|1w] [trend|funding]",
  );
}
if (!isTimeframe(interval)) throw new Error(`Unsupported interval '${interval}'.`);
const strategies: Record<string, string> = { trend: emaTrendStrategy, funding: emaFundingStrategy };
const strategySource = strategies[strategyName];
if (!strategySource) throw new Error(`Unsupported strategy '${strategyName}'. Use trend or funding.`);

const startedAt = performance.now();
const path = resolve(manifestArgument);
const loaded = path.endsWith(".catalog.json") ? await loadHistoricalDataset(path) : await loadMarketSnapshot(path);
const oneMinuteBars = loaded.bars;
const aggregation = aggregateOneMinuteBars(oneMinuteBars, interval);
if (aggregation.bars.length < 2) throw new Error(`Not enough complete ${interval} bars in the snapshot.`);
const result = await runBacktest(strategySource, aggregation.bars);
const metrics = calculateBacktestMetrics(result);
const dataset = "catalog" in loaded
  ? {
      id: loaded.catalog.datasetId,
      source: loaded.catalog.source,
      venue: loaded.catalog.venue,
      instrument: loaded.catalog.instrument,
      partitionHashes: loaded.catalog.partitions.map((partition) => partition.dataSha256),
      quality: {
        missingTradeMinutes: loaded.catalog.observedMissingMinutes,
        missingMarkPrices: loaded.catalog.missingMarkPrices ?? 0,
        fundingEvents: loaded.catalog.fundingEvents ?? 0,
      },
      transforms: {
        missingMarkPrice: (loaded.catalog.missingMarkPrices ?? 0) > 0 ? "trade-close-fallback" : "none",
      },
    }
  : {
      id: loaded.manifest.snapshotId,
      source: loaded.manifest.source,
      venue: loaded.manifest.venue,
      instrument: loaded.manifest.instrument,
      partitionHashes: [loaded.manifest.dataSha256],
      quality: {
        missingTradeMinutes: loaded.manifest.quality.gaps.reduce((sum, gap) => sum + gap.missingBars, 0),
        missingMarkPrices: loaded.manifest.quality.missingMarkPrices ?? 0,
        fundingEvents: loaded.manifest.quality.fundingEvents,
      },
      transforms: {
        missingMarkPrice: (loaded.manifest.quality.missingMarkPrices ?? 0) > 0 ? "trade-close-fallback" : "none",
      },
    };
const backtestId = createHash("sha256")
  .update(JSON.stringify({
    engineVersion: "0.2.0",
    strategyHash: result.strategy.programHash,
    datasetHashes: dataset.partitionHashes,
    interval,
    config: result.config,
  }))
  .digest("hex");
const report = {
  schemaVersion: "1.0",
  backtestId,
  engineVersion: "0.2.0",
  strategy: result.strategy,
  dataset,
  interval,
  sourceRows: oneMinuteBars.length,
  evaluatedBars: aggregation.bars.length,
  incompleteBuckets: aggregation.incompleteBuckets,
  config: result.config,
  metrics,
  initialCapital: result.initialCapital,
  finalEquity: result.finalEquity,
  trades: result.trades,
  equityCurve: result.equityCurve,
  finalState: result.finalState,
};
const reportDirectory = resolve("data/reports/backtests");
await mkdir(reportDirectory, { recursive: true });
const reportPath = resolve(reportDirectory, `${backtestId}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      backtestId,
      reportPath,
      datasetId: dataset.id,
      sourceRows: oneMinuteBars.length,
      interval,
      evaluatedBars: aggregation.bars.length,
      incompleteBuckets: aggregation.incompleteBuckets,
      strategy: result.strategy,
      initialCapital: result.initialCapital,
      finalEquity: result.finalEquity,
      metrics,
      runtimeMs: Math.round(performance.now() - startedAt),
    },
    null,
    2,
  ),
);
