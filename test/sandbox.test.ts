import { describe, expect, it } from "vitest";

import { compileStrategySource } from "../src/compiler/compile-strategy-source.js";
import { runStrategyProgram, StrategySandboxSession } from "../src/runtime/sandbox.js";
import { thresholdStrategy } from "../examples/strategies.js";

const bar = {
  timestamp: Date.UTC(2026, 0, 1),
  open: 100,
  high: 102,
  low: 99,
  close: 101,
  volume: 1_000,
  fundingRate: 0,
  openInterest: 1_000_000,
};

const invocation = {
  bars: [bar],
  position: {
    side: "flat" as const,
    quantity: 0,
    entryPrice: null,
    stopPrice: null,
    takeProfitPrice: null,
    unrealizedPnl: 0,
  },
  equity: 10_000,
  state: {},
};

describe("strategy sandbox", () => {
  it("returns deterministic decisions and explicit state", async () => {
    const first = await runStrategyProgram(thresholdStrategy, invocation);
    const second = await runStrategyProgram(thresholdStrategy, invocation);

    expect(first).toEqual(second);
    expect(first.strategy.programHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.decision).toMatchObject({ type: "open", side: "long" });
    expect(first.state).toEqual({ entries: 1 });
  });

  it("rejects statically invalid decisions before the sandbox boundary", async () => {
    const invalid = `defineStrategy({ id: "bad", name: "bad", version: 1, onBar() { return { type: "open", side: "moon" }; } })`;
    await expect(runStrategyProgram(invalid, invocation)).rejects.toThrow("TS2322");
  });

  it("keeps indicator history in a persistent sandbox session", async () => {
    const indicatorStrategy = `defineStrategy({
      id: "test.incremental-ema",
      name: "Incremental EMA",
      version: 1,
      onBar(ctx) {
        ctx.state.set("ema", ctx.indicators.ema("close", 3));
        return { type: "hold" };
      }
    })`;
    const bars = [100, 101, 102, 104, 103].map((close, index) => ({ ...bar, timestamp: bar.timestamp + index * 60_000, close }));
    const oneShot = await runStrategyProgram(indicatorStrategy, { ...invocation, bars });
    const session = await StrategySandboxSession.create(compileStrategySource(indicatorStrategy));
    let state = {};
    try {
      for (const current of bars) {
        const result = await session.runBar(current, invocation.position, invocation.equity, state);
        state = result.state;
      }
    } finally {
      session.dispose();
    }
    expect(state).toEqual(oneShot.state);
    expect(state).toEqual({ ema: 102.75 });
  });

  it("provides mainstream indicators and bounded read-only history", async () => {
    const indicatorStrategy = `defineStrategy({
      id: "test.mainstream-indicators",
      name: "Mainstream indicators",
      version: 1,
      onBar(ctx) {
        const values = ctx.history.values("close", 5);
        const customMean = values === null ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
        ctx.state.set("customMean", customMean);
        ctx.state.set("rsi", ctx.indicators.rsi("close", 14));
        ctx.state.set("atr", ctx.indicators.atr(14));
        ctx.state.set("macd", ctx.indicators.macd("close", 12, 26, 9));
        ctx.state.set("bands", ctx.indicators.bollingerBands("close", 20, 2));
        return { type: "hold" };
      }
    })`;
    const bars = Array.from({ length: 40 }, (_, index) => ({
      ...bar,
      timestamp: bar.timestamp + index * 60_000,
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
    }));

    const result = await runStrategyProgram(indicatorStrategy, { ...invocation, bars });
    expect(result.state.customMean).toBe(138);
    expect(result.state.rsi).toBe(100);
    expect(result.state.atr).toBeCloseTo(3, 10);
    expect(result.state.macd).toMatchObject({ macd: expect.any(Number), signal: expect.any(Number), histogram: expect.any(Number) });
    expect(result.state.bands).toMatchObject({ middle: expect.any(Number), upper: expect.any(Number), lower: expect.any(Number) });
  });
});
