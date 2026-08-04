import { describe, expect, it } from "vitest";

import type { MarketBar } from "../src/core/types.js";
import { runBacktest, type BacktestTimeframeContext } from "../src/runtime/backtest.js";
import { calculateBacktestMetrics } from "../src/runtime/backtest-metrics.js";
import { emaFundingStrategy, emaTrendStrategy, thresholdStrategy } from "../examples/strategies.js";

const H = 3_600_000;

function bar(timestamp: number, open: number, high: number, low: number, close: number, extra: Partial<MarketBar> = {}): MarketBar {
  return { timestamp, open, high, low, close, volume: 1000, ...extra };
}

function assertRunResult(
  result: Awaited<ReturnType<typeof runBacktest>>,
  bars: MarketBar[],
  expected: { finalEquity: number; tradeCount: number; exitReasons: string[]; netPnls: number[] },
): void {
  expect(result.trades).toHaveLength(expected.tradeCount);
  expect(result.trades.map((trade) => trade.exitReason)).toEqual(expected.exitReasons);
  result.trades.forEach((trade, index) => {
    expect(trade.netPnl).toBeCloseTo(expected.netPnls[index]!, 4);
  });
  expect(result.finalEquity).toBeCloseTo(expected.finalEquity, 4);

  // Equity curve invariants: one point per bar, monotonic timestamps, starts at capital.
  expect(result.equityCurve).toHaveLength(bars.length);
  expect(result.equityCurve[0]!.equity).toBeCloseTo(result.initialCapital, 10);
  for (let index = 1; index < result.equityCurve.length; index += 1) {
    expect(result.equityCurve[index]!.timestamp).toBeGreaterThan(result.equityCurve[index - 1]!.timestamp);
  }

  const metrics = calculateBacktestMetrics(result);
  expect(metrics.tradeCount).toBe(expected.tradeCount);
  expect(metrics.fees).toBeGreaterThan(0);
}

describe("engine golden baseline (Path A migration truth)", () => {
  it("is deterministic: the same bars and program reproduce the same final equity", async () => {
    const start = Date.UTC(2026, 0, 1);
    const bars: MarketBar[] = Array.from({ length: 40 }, (_, index) => bar(start + index * H, 100, 101, 99, 100 + (index >= 20 ? 1 : 0)));
    const first = await runBacktest(thresholdStrategy, bars);
    const second = await runBacktest(thresholdStrategy, bars);
    expect(second.finalEquity).toBe(first.finalEquity);
    expect(second.trades).toEqual(first.trades);
    expect(first.strategy.programHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("threshold strategy: entry at close>=101, exit at close>=105", async () => {
    const start = Date.UTC(2026, 0, 1);
    const bars = [
      bar(start + 0 * H, 100, 100, 99, 100),
      bar(start + 1 * H, 100, 101, 99, 100),
      bar(start + 2 * H, 100, 102, 100, 101),
      bar(start + 3 * H, 101, 102, 100, 101),
      bar(start + 4 * H, 101, 103, 101, 102),
      bar(start + 5 * H, 102, 104, 102, 103),
      bar(start + 6 * H, 103, 105, 103, 104),
      bar(start + 7 * H, 104, 106, 104, 105),
      bar(start + 8 * H, 105, 106, 104, 105),
      bar(start + 9 * H, 105, 105, 104, 104),
    ];
    const result = await runBacktest(thresholdStrategy, bars);
    expect(result.trades[0]).toMatchObject({ side: "long", exitReason: "profit threshold" });
    assertRunResult(result, bars, { finalEquity: 10076.5411, tradeCount: 1, exitReasons: ["profit threshold"], netPnls: [76.5411] });
  });

  it("trend strategy: 20/50 EMA cross, riskPercent sizing", async () => {
    const start = Date.UTC(2026, 0, 1);
    const bars: MarketBar[] = [];
    for (let index = 0; index < 150; index += 1) {
      const close = index < 50 ? 100 : index < 95 ? 100 + (index - 50) * 0.5 : 147.5 - (index - 95) * 0.5;
      bars.push(bar(start + index * H, close - 0.2, close + 0.3, close - 0.3, close));
    }
    const result = await runBacktest(emaTrendStrategy, bars);
    assertRunResult(result, bars, {
      finalEquity: 10463.2742,
      tradeCount: 1,
      exitReasons: ["20-period EMA crossed below 50-period EMA"],
      netPnls: [463.2742],
    });
  });

  it("funding strategy: negative funding gate feeds funding PnL", async () => {
    const start = Date.UTC(2026, 0, 1);
    const bars: MarketBar[] = [];
    for (let index = 0; index < 120; index += 1) {
      const close = index < 40 ? 100 : index < 85 ? 100 + (index - 40) * 0.5 : 122.5 - (index - 85) * 0.5;
      bars.push(bar(start + index * H, close - 0.2, close + 0.3, close - 0.3, close, { fundingRate: index >= 40 && index <= 80 ? -0.0001 : 0 }));
    }
    const result = await runBacktest(emaFundingStrategy, bars);
    const metrics = calculateBacktestMetrics(result);
    expect(metrics.fundingPnl).toBeCloseTo(4.5973, 4);
    expect(result.trades[0]).toMatchObject({ exitReason: "takeProfit" });
    assertRunResult(result, bars, { finalEquity: 10198.9678, tradeCount: 1, exitReasons: ["takeProfit"], netPnls: [198.9678] });
  });

  it("open-interest strategy: OI trend gate", async () => {
    const source = `
defineStrategy({
  id: "golden.oi",
  name: "Open interest trend",
  version: 1,
  onBar(ctx) {
    const sma = ctx.indicators.sma("close", 20);
    if (ctx.position.side === "flat" && ctx.market.openInterest !== null && ctx.market.openInterest > 1_000_000 && sma !== null && ctx.market.close > sma) {
      return { type: "open", side: "long", size: { kind: "riskPercent", value: 0.01 }, stopLossPercent: 0.05, takeProfitRiskReward: 2, reason: "oi rising above sma" };
    }
    if (ctx.position.side === "long" && sma !== null && ctx.market.close < sma) {
      return { type: "close", reason: "close below sma" };
    }
    return { type: "hold" };
  }
})
`;
    const start = Date.UTC(2026, 0, 1);
    const bars: MarketBar[] = [];
    for (let index = 0; index < 120; index += 1) {
      const close = index < 30 ? 100 : index < 85 ? 100 + (index - 30) * 0.4 : 122 - (index - 85) * 0.4;
      bars.push(bar(start + index * H, close - 0.2, close + 0.3, close - 0.3, close, { openInterest: 800_000 + index * 20_000 }));
    }
    const result = await runBacktest(source, bars);
    assertRunResult(result, bars, {
      finalEquity: 10348.7725,
      tradeCount: 3,
      exitReasons: ["takeProfit", "takeProfit", "close below sma"],
      netPnls: [197.6702, 201.5775, -50.4753],
    });
  });

  it("multi-timeframe strategy: closed 1h RSI gate on a 15m primary", async () => {
    const source = `
defineStrategy({
  id: "golden.mtf",
  name: "Multi-timeframe RSI",
  version: 1,
  onBar(ctx) {
    const hour = ctx.timeframe("1h");
    const rsi = hour === null ? null : hour.indicators.rsi("close", 14);
    const sma = ctx.indicators.sma("close", 20);
    if (ctx.position.side === "flat" && rsi !== null && rsi < 30 && sma !== null && ctx.market.close > sma) {
      return { type: "open", side: "long", size: { kind: "riskPercent", value: 0.01 }, stopLossPercent: 0.05, takeProfitRiskReward: 2, reason: "1h rsi oversold above 15m sma" };
    }
    if (ctx.position.side === "long" && rsi !== null && rsi > 70) {
      return { type: "close", reason: "1h rsi overbought" };
    }
    return { type: "hold" };
  }
})
`;
    const start = Date.UTC(2026, 0, 1);
    const bars15m: MarketBar[] = [];
    for (let index = 0; index < 288; index += 1) {
      const close = 100 + index * 0.02;
      bars15m.push(bar(start + index * 15 * 60_000, close - 0.2, close + 0.3, close - 0.3, close));
    }
    const bars1h: MarketBar[] = [];
    for (let index = 0; index < 96; index += 1) {
      const close = index < 16 ? 100 : index < 32 ? 100 - (index - 16) * 1.2 : index < 48 ? 82 : 82 + (index - 48) * 0.8;
      bars1h.push(bar(start + index * H, close - 0.2, close + 0.3, close - 0.3, close));
    }
    const timeframe: BacktestTimeframeContext = { primaryTimeframe: "15m", bars: { "1h": bars1h } };
    const result = await runBacktest(source, bars15m, {}, timeframe);
    assertRunResult(result, bars15m, {
      finalEquity: 10057.4048,
      tradeCount: 1,
      exitReasons: ["1h rsi overbought"],
      netPnls: [57.4048],
    });
  });

  it("same-bar stop/take-profit conflict: stop wins deterministically", async () => {
    const source = `
defineStrategy({
  id: "golden.conflict",
  name: "Same-bar stop vs take-profit",
  version: 1,
  onBar(ctx) {
    if (ctx.position.side === "flat" && ctx.market.close > 100) {
      return { type: "open", side: "long", size: { kind: "fixedNotional", value: 1000 }, stopLossPercent: 0.05, takeProfitRiskReward: 2, reason: "enter above 100" };
    }
    return { type: "hold" };
  }
})
`;
    const start = Date.UTC(2026, 0, 1);
    const bars = [
      bar(start + 0 * H, 100, 101, 99, 100),
      bar(start + 1 * H, 100, 102, 100, 101),
      bar(start + 2 * H, 101, 101, 100, 101),
      bar(start + 3 * H, 101, 112, 94, 105),
      bar(start + 4 * H, 105, 106, 104, 105),
    ];
    const result = await runBacktest(source, bars);
    // Bar index 3 spans both the 5% stop and the 10% take profit; the engine must
    // close at the stop first, then re-enter on the same close and hold to end.
    expect(result.trades.map((trade) => trade.exitReason)).toEqual(["stopLoss", "endOfData"]);
    assertRunResult(result, bars, { finalEquity: 9947.6328, tradeCount: 2, exitReasons: ["stopLoss", "endOfData"], netPnls: [-51.0674, -1.2997] });
  });
});
