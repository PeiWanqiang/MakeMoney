import { describe, expect, it } from "vitest";

import { runBacktest } from "../src/runtime/backtest.js";
import { calculateBacktestMetrics } from "../src/runtime/backtest-metrics.js";
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
    expect(calculateBacktestMetrics(first)).toMatchObject({
      tradeCount: 1,
      winningTrades: 1,
      losingTrades: 0,
      fees: 0,
      fundingPnl: 0,
      slippageCost: 0,
      winRate: 1,
    });
  });

  it("exposes a higher timeframe only after its bar has closed", async () => {
    const source = `defineStrategy({
      id: "test.closed-timeframe",
      name: "Closed timeframe only",
      version: 1,
      onBar(ctx) {
        const firstSeen = ctx.state.get("firstSeen", -1);
        const hourly = ctx.timeframe("1h");
        if (hourly !== null && firstSeen === -1) ctx.state.set("firstSeen", ctx.market.timestamp);
        return { type: "hold" };
      }
    })`;
    const start = Date.UTC(2026, 0, 1);
    const quarterHourBars = Array.from({ length: 5 }, (_, index) => ({
      timestamp: start + index * 15 * 60_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1_000,
    }));
    const hourlyBars = [{
      timestamp: start,
      open: 100,
      high: 105,
      low: 98,
      close: 104,
      volume: 4_000,
    }];

    const result = await runBacktest(source, quarterHourBars, {}, {
      primaryTimeframe: "15m",
      bars: { "1h": hourlyBars },
    });
    expect(result.finalState.firstSeen).toBe(start + 45 * 60_000);
  });
});
