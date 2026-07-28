import { describe, expect, it } from "vitest";

import { runStrategyProgram } from "../src/runtime/sandbox.js";
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

  it("rejects invalid decisions at the sandbox boundary", async () => {
    const invalid = `defineStrategy({ id: "bad", name: "bad", version: 1, onBar() { return { type: "open", side: "moon" }; } })`;
    await expect(runStrategyProgram(invalid, invocation)).rejects.toThrow("side must be");
  });
});
