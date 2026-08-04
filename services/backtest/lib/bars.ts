import type { MarketBar } from "../../../src/core/types.js";
import type { ServiceBar } from "../../../src/contracts/index.js";

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
