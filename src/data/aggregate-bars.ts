import { TIMEFRAME_MS, type Timeframe, timeframeBucketStart } from "../core/timeframes.js";
import type { MarketBar } from "../core/types.js";

export const AGGREGATE_INTERVALS = TIMEFRAME_MS;

export type AggregateInterval = Timeframe;

export interface AggregationResult {
  bars: MarketBar[];
  interval: AggregateInterval;
  incompleteBuckets: number;
}

export function aggregateOneMinuteBars(source: MarketBar[], interval: AggregateInterval): AggregationResult {
  const targetMs = AGGREGATE_INTERVALS[interval];
  const expectedBars = targetMs / AGGREGATE_INTERVALS["1m"];
  if (interval === "1m") return { bars: [...source], interval, incompleteBuckets: 0 };

  const buckets = new Map<number, MarketBar[]>();
  for (const bar of [...source].sort((a, b) => a.timestamp - b.timestamp)) {
    const bucketTimestamp = timeframeBucketStart(bar.timestamp, interval);
    const bucket = buckets.get(bucketTimestamp) ?? [];
    bucket.push(bar);
    buckets.set(bucketTimestamp, bucket);
  }

  const bars: MarketBar[] = [];
  let incompleteBuckets = 0;
  for (const [timestamp, bucket] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const complete =
      bucket.length === expectedBars &&
      bucket.every((bar, index) => bar.timestamp === timestamp + index * AGGREGATE_INTERVALS["1m"]);
    if (!complete) {
      incompleteBuckets += 1;
      continue;
    }
    const first = bucket[0];
    const last = bucket.at(-1);
    if (!first || !last) continue;
    const aggregated: MarketBar = {
      timestamp,
      open: first.open,
      high: Math.max(...bucket.map((bar) => bar.high)),
      low: Math.min(...bucket.map((bar) => bar.low)),
      close: last.close,
      volume: bucket.reduce((sum, bar) => sum + bar.volume, 0),
      fundingRate: bucket.reduce((sum, bar) => sum + (bar.fundingRate ?? 0), 0),
      ...(last.markPrice === undefined ? {} : { markPrice: last.markPrice }),
      ...(last.openInterest === undefined ? {} : { openInterest: last.openInterest }),
      // Turnover/taker volumes sum like base volume. The last bar gates because
      // every bar in a bucket comes from the same source, matching markPrice.
      ...(last.quoteVolume === undefined ? {} : { quoteVolume: bucket.reduce((sum, bar) => sum + (bar.quoteVolume ?? 0), 0) }),
      ...(last.takerBuyBaseVolume === undefined
        ? {}
        : { takerBuyBaseVolume: bucket.reduce((sum, bar) => sum + (bar.takerBuyBaseVolume ?? 0), 0) }),
      ...(last.takerBuyQuoteVolume === undefined
        ? {}
        : { takerBuyQuoteVolume: bucket.reduce((sum, bar) => sum + (bar.takerBuyQuoteVolume ?? 0), 0) }),
    };
    bars.push(aggregated);
  }
  return { bars, interval, incompleteBuckets };
}
