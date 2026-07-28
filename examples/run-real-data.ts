import { resolve } from "node:path";

import { emaFundingStrategy } from "./strategies.js";
import { aggregateOneMinuteBars, type AggregateInterval } from "../src/data/aggregate-bars.js";
import { loadHistoricalDataset } from "../src/data/historical-dataset.js";
import { loadMarketSnapshot } from "../src/data/market-snapshot.js";
import { runBacktest } from "../src/runtime/backtest.js";

const manifestArgument = process.argv[2];
const interval = (process.argv[3] ?? "1h") as AggregateInterval;
if (!manifestArgument) {
  throw new Error("Usage: npm run backtest:real -- /absolute/path/to/snapshot.manifest.json-or-dataset.catalog.json [15m|1h|4h]");
}

const path = resolve(manifestArgument);
const loaded = path.endsWith(".catalog.json") ? await loadHistoricalDataset(path) : await loadMarketSnapshot(path);
const oneMinuteBars = loaded.bars;
const aggregation = aggregateOneMinuteBars(oneMinuteBars, interval);
if (aggregation.bars.length < 2) throw new Error(`Not enough complete ${interval} bars in the snapshot.`);
const result = await runBacktest(emaFundingStrategy, aggregation.bars);

console.log(
  JSON.stringify(
    {
      datasetId: "catalog" in loaded ? loaded.catalog.datasetId : loaded.manifest.snapshotId,
      sourceRows: oneMinuteBars.length,
      interval,
      bars: aggregation.bars.length,
      incompleteBuckets: aggregation.incompleteBuckets,
      strategy: result.strategy,
      initialCapital: result.initialCapital,
      finalEquity: result.finalEquity,
      returnPercent: result.returnPercent,
      trades: result.trades.length,
    },
    null,
    2,
  ),
);
