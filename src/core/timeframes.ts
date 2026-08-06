/**
 * The one list of tradable bar intervals.
 *
 * Every layer used to carry its own copy of `"1m" | "15m" | "1h" | "4h"` — the
 * contract type, the JSON Schema enum, four expression regexes, the sandbox
 * record, the aggregator. Adding an interval meant finding all of them, and
 * missing one produced a contract the analyzer accepts but the engine rejects.
 * They all derive from here now.
 */
export const TIMEFRAMES = ["1m", "15m", "1h", "4h", "1d", "1w"] as const;

export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

/** Alternation body for embedding in expression regexes: `1m|15m|1h|4h|1d|1w`. */
export const TIMEFRAME_PATTERN = TIMEFRAMES.join("|");

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === "string" && (TIMEFRAMES as readonly string[]).includes(value);
}

/**
 * Weekly bars open on Monday, not on the epoch.
 *
 * `floor(ts / week)` would anchor buckets to 1970-01-01, a Thursday, so every
 * aggregated week would straddle two of Binance's. That is not a cosmetic
 * difference: a strategy reading `timeframe("1w")` off aggregated bars would
 * see different highs and lows than the same strategy running natively on 1w
 * klines. Monday 1970-01-05 00:00 UTC is 345,600,000 ms in, and shifting the
 * grid by that lines the two up. Every other interval divides the UTC day
 * evenly, so their epoch-anchored buckets already match.
 */
const WEEK_ANCHOR_MS = 4 * 24 * 60 * 60_000;

export function timeframeBucketStart(timestamp: number, timeframe: Timeframe): number {
  const interval = TIMEFRAME_MS[timeframe];
  if (timeframe !== "1w") return Math.floor(timestamp / interval) * interval;
  return Math.floor((timestamp - WEEK_ANCHOR_MS) / interval) * interval + WEEK_ANCHOR_MS;
}
