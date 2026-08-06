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

describe("partial position exits", () => {
  /** Opens a fixed 1000 notional long, scales out at `first`, flattens at `second`. */
  const scaleOutStrategy = (first: number, second: number) => `defineStrategy({
    id: "test.scale-out",
    name: "Scale out",
    version: 1,
    onBar(ctx) {
      const scaledOut = ctx.state.get("scaledOut", 0);
      if (ctx.position.side === "flat") {
        if (ctx.market.close < 100) return { type: "hold" };
        ctx.state.set("scaledOut", 0);
        return { type: "open", side: "long", size: { kind: "fixedNotional", value: 1000 }, stopLossPercent: 0.5 };
      }
      if (ctx.market.close >= ${second}) return { type: "close", reason: "target" };
      if (ctx.market.close >= ${first} && scaledOut === 0) {
        ctx.state.set("scaledOut", 1);
        return { type: "close", fraction: 0.5, reason: "scale out" };
      }
      return { type: "hold" };
    }
  })`;

  const risingBars = (closes: number[]) => closes.map((close, index) => ({
    timestamp: Date.UTC(2026, 0, 1, index),
    open: index === 0 ? close : (closes[index - 1] ?? close),
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1_000,
  }));

  const zeroCost = { initialCapital: 10_000, takerFeeRate: 0, slippageBps: 0, maxLeverage: 3 };

  it("closes half the position and keeps the rest open at the original entry price", async () => {
    // Enters at 100, scales out half at 110, flattens the remainder at 120.
    const bars = risingBars([100, 100, 100, 110, 110, 120, 120]);
    const result = await runBacktest(scaleOutStrategy(110, 120), bars, zeroCost);

    expect(result.trades).toHaveLength(2);
    const [scaleOut, flatten] = result.trades;
    expect(scaleOut).toMatchObject({ side: "long", entryPrice: 100, exitPrice: 110, exitReason: "scale out" });
    expect(flatten).toMatchObject({ side: "long", entryPrice: 100, exitPrice: 120, exitReason: "target" });
    // 1000 notional at 100 is 10 units; each leg carries half of it.
    expect(scaleOut!.quantity).toBeCloseTo(5, 10);
    expect(flatten!.quantity).toBeCloseTo(5, 10);
    expect(scaleOut!.netPnl).toBeCloseTo(50, 10);
    expect(flatten!.netPnl).toBeCloseTo(100, 10);
    expect(result.finalEquity).toBeCloseTo(10_150, 10);
  });

  it("splits the entry cost across the legs instead of charging it to the first", async () => {
    const bars = risingBars([100, 100, 100, 110, 110, 120, 120]);
    const result = await runBacktest(scaleOutStrategy(110, 120), bars, {
      initialCapital: 10_000,
      takerFeeRate: 0.001,
      slippageBps: 0,
      maxLeverage: 3,
    });

    const [scaleOut, flatten] = result.trades;
    // Entry fee is 1000 * 0.001 = 1, split evenly; each exit pays its own leg.
    expect(scaleOut!.fees).toBeCloseTo(0.5 + 550 * 0.001, 10);
    expect(flatten!.fees).toBeCloseTo(0.5 + 600 * 0.001, 10);
    const totalFees = result.trades.reduce((sum, trade) => sum + trade.fees, 0);
    expect(totalFees).toBeCloseTo(1 + 0.55 + 0.6, 10);
  });

  it("treats a fraction that leaves nothing behind as a whole exit", async () => {
    const source = `defineStrategy({
      id: "test.close-all",
      name: "Close all",
      version: 1,
      onBar(ctx) {
        if (ctx.position.side === "flat") {
          return { type: "open", side: "long", size: { kind: "fixedNotional", value: 1000 }, stopLossPercent: 0.5 };
        }
        if (ctx.market.close >= 110) return { type: "close", fraction: 1, reason: "target" };
        return { type: "hold" };
      }
    })`;
    const bars = risingBars([100, 100, 110, 110, 110]);
    const result = await runBacktest(source, bars, zeroCost);

    // The exit closes everything, so re-entry is possible on the following bar.
    expect(result.trades[0]).toMatchObject({ exitReason: "target", quantity: 10 });
    expect(result.trades.every((trade) => trade.exitReason !== "endOfData" || trade.quantity > 0)).toBe(true);
  });

  it("rejects a fraction the engine cannot honor", async () => {
    const source = (fraction: string) => `defineStrategy({
      id: "test.bad-fraction",
      name: "Bad fraction",
      version: 1,
      onBar(ctx) {
        if (ctx.position.side === "flat") {
          return { type: "open", side: "long", size: { kind: "fixedNotional", value: 1000 }, stopLossPercent: 0.5 };
        }
        return { type: "close", fraction: ${fraction} };
      }
    })`;
    const bars = risingBars([100, 100, 100, 100]);
    await expect(runBacktest(source("0"), bars, zeroCost)).rejects.toThrow(/fraction/);
    await expect(runBacktest(source("1.5"), bars, zeroCost)).rejects.toThrow(/fraction/);
  });
});
