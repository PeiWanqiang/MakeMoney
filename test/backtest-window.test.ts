import { describe, expect, it } from "vitest";

import type { MarketBar } from "../src/core/types.js";
import { runBacktest } from "../src/runtime/backtest.js";

const H = 3_600_000;

function bar(timestamp: number, open: number, high: number, low: number, close: number): MarketBar {
  return { timestamp, open, high, low, close, volume: 1000 };
}

const SMA_SOURCE = `
defineStrategy({
  id: "golden.window",
  name: "SMA window",
  version: 1,
  onBar(ctx) {
    const sma = ctx.indicators.sma("close", 5);
    if (ctx.position.side === "flat" && sma !== null && ctx.market.close > sma) {
      return { type: "open", side: "long", size: { kind: "fixedNotional", value: 1000 }, stopLossPercent: 0.05, takeProfitRiskReward: 2, reason: "above sma" };
    }
    if (ctx.position.side === "long" && sma !== null && ctx.market.close < sma) {
      return { type: "close", reason: "below sma" };
    }
    return { type: "hold" };
  }
})
`;

describe("runBacktest evaluationStartTime (performance window)", () => {
  it("without the window flag, every bar is evaluated", async () => {
    const start = Date.UTC(2026, 0, 1);
    const bars = Array.from({ length: 30 }, (_, index) => {
      const close = 100 + index * 0.2;
      return bar(start + index * H, close - 0.2, close + 0.3, close - 0.3, close);
    });
    const full = await runBacktest(SMA_SOURCE, bars);
    expect(full.equityCurve).toHaveLength(30);
  });

  it("warm-up history feeds indicators while nothing trades or measures before the window", async () => {
    const start = Date.UTC(2026, 0, 1);
    const bars = Array.from({ length: 30 }, (_, index) => {
      const close = 100 + index * 0.2;
      return bar(start + index * H, close - 0.2, close + 0.3, close - 0.3, close);
    });
    // Window starts at bar 4. The sandbox has already seen bars 0-3, so the
    // SMA(5) is warm and the strategy can open at the window start; a cold
    // restart at bar 4 would leave SMA(5) null until bar 8.
    const startIndex = 4;
    const result = await runBacktest(SMA_SOURCE, bars, { evaluationStartTime: bars[startIndex]!.timestamp });
    expect(result.equityCurve).toHaveLength(bars.length - startIndex);
    expect(result.equityCurve[0]!.equity).toBeCloseTo(result.initialCapital, 6);
    expect(result.trades.length).toBeGreaterThanOrEqual(1);
    for (const trade of result.trades) {
      expect(trade.entryTimestamp).toBeGreaterThanOrEqual(bars[startIndex]!.timestamp);
    }
    // The strategy opened at the first in-window bar thanks to warm-up: the
    // close (100.8) sits above the warm SMA(5) average of bars 0-4.
    expect(result.trades[0]!.entryTimestamp).toBe(bars[startIndex + 1]!.timestamp);
  });

  it("rejects a window with fewer than two bars", async () => {
    const start = Date.UTC(2026, 0, 1);
    const bars = Array.from({ length: 10 }, (_, index) => {
      const close = 100 + index;
      return bar(start + index * H, close - 0.2, close + 0.3, close - 0.3, close);
    });
    const late = bars[9]!.timestamp + 1;
    await expect(runBacktest(SMA_SOURCE, bars, { evaluationStartTime: late })).rejects.toThrow("at least two");
  });
});
