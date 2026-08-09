import type { MarketBar } from "../../../src/core/types.js";
import type { ServiceBacktestConfig, ServiceBar } from "../../../src/contracts/index.js";
import { CodedServiceError } from "./errors.js";

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const OPTIONAL_NUMERIC_FIELDS = [
  "markPrice",
  "fundingRate",
  "openInterest",
  "quoteVolume",
  "takerBuyBaseVolume",
  "takerBuyQuoteVolume",
] as const;

/** Runtime validation shared by backtest and optimization service boundaries. */
export function validateServiceBars(value: unknown, label = "bars", minimumLength = 2): asserts value is ServiceBar[] {
  if (!Array.isArray(value) || value.length < minimumLength) {
    throw new CodedServiceError("BAD_REQUEST", `${label} must contain at least ${minimumLength} market bars.`, 400);
  }
  let previousTimestamp = -Infinity;
  value.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new CodedServiceError("BAD_REQUEST", `${label}[${index}] must be a market bar object.`, 400);
    }
    const bar = candidate as Record<string, unknown>;
    for (const field of ["timestamp", "open", "high", "low", "close", "volume"] as const) {
      if (!isFiniteNumber(bar[field])) {
        throw new CodedServiceError("BAD_REQUEST", `${label}[${index}].${field} must be a finite number.`, 400);
      }
    }
    for (const field of OPTIONAL_NUMERIC_FIELDS) {
      if (bar[field] !== undefined && !isFiniteNumber(bar[field])) {
        throw new CodedServiceError("BAD_REQUEST", `${label}[${index}].${field} must be finite when provided.`, 400);
      }
    }
    const timestamp = bar.timestamp as number;
    const open = bar.open as number;
    const high = bar.high as number;
    const low = bar.low as number;
    const close = bar.close as number;
    const volume = bar.volume as number;
    if (!Number.isSafeInteger(timestamp) || timestamp <= previousTimestamp) {
      throw new CodedServiceError("BAD_REQUEST", `${label} timestamps must be safe integers in strictly increasing order.`, 400);
    }
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
      throw new CodedServiceError("BAD_REQUEST", `${label}[${index}] violates positive OHLC price bounds.`, 400);
    }
    if (volume < 0) throw new CodedServiceError("BAD_REQUEST", `${label}[${index}].volume cannot be negative.`, 400);
    if (typeof bar.markPrice === "number" && bar.markPrice <= 0) {
      throw new CodedServiceError("BAD_REQUEST", `${label}[${index}].markPrice must be greater than zero.`, 400);
    }
    for (const field of ["openInterest", "quoteVolume", "takerBuyBaseVolume", "takerBuyQuoteVolume"] as const) {
      const number = bar[field];
      if (typeof number === "number" && number < 0) {
        throw new CodedServiceError("BAD_REQUEST", `${label}[${index}].${field} cannot be negative.`, 400);
      }
    }
    previousTimestamp = timestamp;
  });
}

export function validateServiceConfig(config: ServiceBacktestConfig | undefined, label = "config"): void {
  if (!config || typeof config !== "object") {
    throw new CodedServiceError("BAD_REQUEST", `${label} is required.`, 400);
  }
  for (const field of ["initialCapital", "takerFeeRate", "slippageBps", "maxLeverage"] as const) {
    if (!isFiniteNumber(config[field])) {
      throw new CodedServiceError("BAD_REQUEST", `${label}.${field} must be a finite number.`, 400);
    }
  }
  if (config.initialCapital <= 0) throw new CodedServiceError("BAD_REQUEST", `${label}.initialCapital must be greater than zero.`, 400);
  if (config.takerFeeRate < 0 || config.takerFeeRate >= 1) {
    throw new CodedServiceError("BAD_REQUEST", `${label}.takerFeeRate must be in [0, 1).`, 400);
  }
  if (config.slippageBps < 0 || config.slippageBps >= 10_000) {
    throw new CodedServiceError("BAD_REQUEST", `${label}.slippageBps must be in [0, 10000).`, 400);
  }
  if (config.maxLeverage <= 0) throw new CodedServiceError("BAD_REQUEST", `${label}.maxLeverage must be greater than zero.`, 400);
}

/** Converts wire-safe bars to engine `MarketBar`, dropping absent derivative fields. */
export function serviceBarsToMarketBars(bars: ServiceBar[]): MarketBar[] {
  return bars.map((bar) => ({
    timestamp: bar.timestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    ...(bar.markPrice !== undefined ? { markPrice: bar.markPrice } : {}),
    ...(bar.fundingRate !== undefined ? { fundingRate: bar.fundingRate } : {}),
    ...(bar.openInterest !== undefined ? { openInterest: bar.openInterest } : {}),
    ...(bar.quoteVolume !== undefined ? { quoteVolume: bar.quoteVolume } : {}),
    ...(bar.takerBuyBaseVolume !== undefined ? { takerBuyBaseVolume: bar.takerBuyBaseVolume } : {}),
    ...(bar.takerBuyQuoteVolume !== undefined ? { takerBuyQuoteVolume: bar.takerBuyQuoteVolume } : {}),
  }));
}
