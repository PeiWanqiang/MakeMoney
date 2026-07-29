import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { aggregateOneMinuteBars } from "../src/data/aggregate-bars.js";
import {
  loadHistoricalDataset,
  parseBinanceKline,
  parseBinanceFundingRate,
  parseKrakenKline,
  writeDatasetCatalog,
  writeHistoricalPartition,
} from "../src/data/historical-dataset.js";
import type { NormalizedMarketBar } from "../src/data/hyperliquid-client.js";

function bar(timestamp: number, price: number): NormalizedMarketBar {
  return {
    timestamp,
    endTimestamp: timestamp + 59_999,
    open: price,
    high: price + 2,
    low: price - 1,
    close: price + 1,
    volume: 2,
    trades: 3,
    fundingRate: 0,
    fundingPremium: 0,
  };
}

describe("historical 1m data", () => {
  it("normalizes Binance millisecond and microsecond timestamps", () => {
    const milliseconds = parseBinanceKline("1704067200000,42000,42002,41999,42001,2,1704067259999,0,3,0,0,0");
    const microseconds = parseBinanceKline("1704067200000000,42000,42002,41999,42001,2,1704067259999999,0,3,0,0,0");
    expect(milliseconds?.timestamp).toBe(1_704_067_200_000);
    expect(microseconds?.timestamp).toBe(milliseconds?.timestamp);
  });

  it("normalizes Kraken second timestamps", () => {
    const parsed = parseKrakenKline("1704067200,42000,42002,41999,42001,2,3");
    expect(parsed).toMatchObject({ timestamp: 1_704_067_200_000, close: 42_001, trades: 3 });
  });

  it("aligns millisecond-offset Binance funding events to their minute", () => {
    expect(parseBinanceFundingRate("1577923200002,8,0.00003662")).toEqual({
      timestamp: 1_577_923_200_000,
      intervalHours: 8,
      rate: 0.00003662,
    });
    expect(parseBinanceFundingRate("calc_time,funding_interval_hours,last_funding_rate")).toBeUndefined();
  });

  it("aggregates only complete minute buckets", () => {
    const start = Date.parse("2024-01-01T00:00:00Z");
    const complete = Array.from({ length: 15 }, (_, index) => bar(start + index * 60_000, 100 + index));
    const result = aggregateOneMinuteBars([...complete, bar(start + 15 * 60_000, 200)], "15m");
    expect(result.bars).toHaveLength(1);
    expect(result.incompleteBuckets).toBe(1);
    expect(result.bars[0]).toMatchObject({ open: 100, high: 116, low: 99, close: 115, volume: 30 });
  });

  it("round-trips a partitioned Parquet dataset with hash verification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "btc-history-"));
    try {
      const start = Date.parse("2024-01-01T00:00:00Z");
      const partition = await writeHistoricalPartition(
        {
          month: "2024-01",
          coin: "BTC",
          requestedStart: start,
          requestedEnd: start + 119_999,
          bars: [{ ...bar(start, 100), markPrice: 100.5 }, { ...bar(start + 60_000, 101), markPrice: 101.5 }],
          identity: {
            source: "binance-vision",
            venue: "binance-spot",
            instrument: "BTCUSDT",
            filePrefix: "binance-spot-btcusdt",
          },
        },
        directory,
      );
      const catalogPath = await writeDatasetCatalog(
        directory,
        {
          source: "binance-vision",
          venue: "binance-spot",
          instrument: "BTCUSDT",
          requestedStart: start,
          requestedEnd: start + 120_000,
        },
        [partition],
      );
      const loaded = await loadHistoricalDataset(catalogPath);
      expect(loaded.catalog).toMatchObject({ rowCount: 2, expectedMinutes: 2, observedMissingMinutes: 0 });
      expect(loaded.bars.map((item) => item.close)).toEqual([101, 102]);
      expect(loaded.bars.map((item) => item.markPrice)).toEqual([100.5, 101.5]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
