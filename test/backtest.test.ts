import { describe, expect, it } from "vitest";

import { runBacktest } from "../src/runtime/backtest.js";
import { thresholdStrategy } from "../examples/strategies.js";

describe("deterministic bar backtest", () => {
  it("executes decisions on the next bar and records a reproducible trade", async () => {
    const closes = [98, 99, 101, 102, 106, 107, 105, 103];
    const bars = closes.map((close, index) => ({
      timestamp: Date.UTC(2026, 0, 1, index),
      open: index === 0 ? close : (closes[index - 1] ?? close),
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 1_000,
      fundingRate: 0,
      openInterest: 1_000_000,
    }));

    const first = await runBacktest(thresholdStrategy, bars, {
      initialCapital: 10_000,
      takerFeeRate: 0,
      slippageBps: 0,
      maxLeverage: 3,
    });
    const second = await runBacktest(thresholdStrategy, bars, {
      initialCapital: 10_000,
      takerFeeRate: 0,
      slippageBps: 0,
      maxLeverage: 3,
    });

    expect(first).toEqual(second);
    expect(first.trades).toHaveLength(1);
    expect(first.trades[0]).toMatchObject({
      side: "long",
      entryPrice: 101,
      exitPrice: 106,
      exitReason: "profit threshold",
    });
    expect(first.finalEquity).toBeGreaterThan(first.initialCapital);
    expect(first.finalState).toEqual({ entries: 1 });
  });
});

