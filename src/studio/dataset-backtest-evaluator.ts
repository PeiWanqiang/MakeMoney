import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { aggregateOneMinuteBars, type AggregateInterval } from "../data/aggregate-bars.js";
import { loadHistoricalDataset } from "../data/historical-dataset.js";
import { loadMarketSnapshot } from "../data/market-snapshot.js";
import { runBacktest } from "../runtime/backtest.js";
import { calculateBacktestMetrics } from "../runtime/backtest-metrics.js";
import type { StrategyEvaluation, StrategyEvaluator } from "./types.js";

export interface DatasetBacktestEvaluatorOptions {
  datasetPath: string;
  interval?: AggregateInterval;
  reportDirectory?: string;
}

export class DatasetBacktestEvaluator implements StrategyEvaluator {
  private readonly datasetPath: string;
  private readonly interval: AggregateInterval;
  private readonly reportDirectory: string;

  constructor(options: DatasetBacktestEvaluatorOptions) {
    this.datasetPath = resolve(options.datasetPath);
    this.interval = options.interval ?? "4h";
    this.reportDirectory = resolve(options.reportDirectory ?? "data/reports/backtests");
  }

  async evaluate(source: string): Promise<StrategyEvaluation> {
    const loaded = this.datasetPath.endsWith(".catalog.json")
      ? await loadHistoricalDataset(this.datasetPath)
      : await loadMarketSnapshot(this.datasetPath);
    const oneMinuteBars = loaded.bars;
    const aggregation = aggregateOneMinuteBars(oneMinuteBars, this.interval);
    if (aggregation.bars.length < 2) throw new Error(`Not enough complete ${this.interval} bars in the dataset.`);
    const result = await runBacktest(source, aggregation.bars);
    const metrics = calculateBacktestMetrics(result);
    const dataset = "catalog" in loaded
      ? {
          id: loaded.catalog.datasetId,
          source: loaded.catalog.source,
          venue: loaded.catalog.venue,
          instrument: loaded.catalog.instrument,
          partitionHashes: loaded.catalog.partitions.map((partition) => partition.dataSha256),
        }
      : {
          id: loaded.manifest.snapshotId,
          source: loaded.manifest.source,
          venue: loaded.manifest.venue,
          instrument: loaded.manifest.instrument,
          partitionHashes: [loaded.manifest.dataSha256],
        };
    const evaluationId = createHash("sha256")
      .update(JSON.stringify({
        engineVersion: "0.2.0",
        strategyHash: result.strategy.programHash,
        datasetHashes: dataset.partitionHashes,
        interval: this.interval,
        config: result.config,
      }))
      .digest("hex");
    const report = {
      schemaVersion: "1.0",
      backtestId: evaluationId,
      engineVersion: "0.2.0",
      strategy: result.strategy,
      dataset,
      interval: this.interval,
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
    await mkdir(this.reportDirectory, { recursive: true });
    const reportPath = resolve(this.reportDirectory, `${evaluationId}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return {
      evaluationId,
      reportPath,
      datasetId: dataset.id,
      interval: this.interval,
      sourceRows: oneMinuteBars.length,
      evaluatedBars: aggregation.bars.length,
      metrics,
      initialCapital: result.initialCapital,
      finalEquity: result.finalEquity,
    };
  }
}
