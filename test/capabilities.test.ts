import { describe, expect, it } from "vitest";

import { usedCapabilities, type StrategyCapability } from "../src/semantics/capabilities.js";

function capabilities(source: string): string[] {
  return [...usedCapabilities(source)].sort();
}

describe("usedCapabilities", () => {
  it("reports OHLCV-only programs as ohlcv + indicators", () => {
    const source = `
defineStrategy({ id: "x", name: "x", version: 1, onBar(ctx) {
  const sma = ctx.indicators.sma("close", 20);
  if (ctx.position.side === "flat" && sma !== null && ctx.market.close > sma) {
    return { type: "open", side: "long", size: { kind: "riskPercent", value: 0.01 }, stopLossPercent: 0.05 };
  }
  return { type: "hold" };
} })
`;
    const used = capabilities(source);
    expect(used).toContain("ohlcv");
    expect(used).toContain("indicators");
    expect(used).not.toContain("fundingRate");
    expect(used).not.toContain("openInterest");
  });

  it("detects fundingRate read straight off the market bar", () => {
    const source = `
defineStrategy({ id: "x", name: "x", version: 1, onBar(ctx) {
  if (ctx.position.side === "flat" && ctx.market.fundingRate < 0) {
    return { type: "open", side: "long", size: { kind: "riskPercent", value: 0.01 }, stopLossPercent: 0.05 };
  }
  return { type: "hold" };
} })
`;
    expect(capabilities(source)).toContain("fundingRate");
  });

  it("detects openInterest referenced through a timeframe view and an indicator field argument", () => {
    const source = `
defineStrategy({ id: "x", name: "x", version: 1, onBar(ctx) {
  const hour = ctx.timeframe("1h");
  const change = ctx.indicators.percentChange("openInterest", 20);
  if (hour !== null && hour.market.openInterest > 1_000_000 && change !== null) {
    return { type: "open", side: "long", size: { kind: "fixedNotional", value: 1000 }, stopLossPercent: 0.05 };
  }
  return { type: "hold" };
} })
`;
    const used = capabilities(source);
    expect(used).toContain("openInterest");
    expect(used).toContain("multiTimeframe");
  });

  it("detects turnover via history.values and state via state.get", () => {
    const source = `
defineStrategy({ id: "x", name: "x", version: 1, onBar(ctx) {
  const turnover = ctx.history.values("quoteVolume", 20);
  const seen = ctx.state.get("seen", 0);
  if (turnover !== null && seen === 0) {
    ctx.state.set("seen", 1);
    return { type: "open", side: "long", size: { kind: "equityPercent", value: 0.5 }, stopLossPercent: 0.05 };
  }
  return { type: "hold" };
} })
`;
    const used = capabilities(source);
    expect(used).toContain("turnover");
    expect(used).toContain("state");
  });

  it("detects destructured market fields", () => {
    const source = `
defineStrategy({ id: "x", name: "x", version: 1, onBar(ctx) {
  const { close, fundingRate } = ctx.market;
  if (close > 100 && fundingRate < 0) {
    return { type: "open", side: "long", size: { kind: "riskPercent", value: 0.01 }, stopLossPercent: 0.05 };
  }
  return { type: "hold" };
} })
`;
    const used = capabilities(source);
    expect(used).toContain("fundingRate");
    expect(used).toContain("ohlcv");
  });

  it("reports arithmetic for math expressions", () => {
    const source = `
defineStrategy({ id: "x", name: "x", version: 1, onBar(ctx) {
  if (ctx.position.side === "flat" && ctx.market.close * 2 > 100 + ctx.market.open / 1) {
    return { type: "open", side: "long", size: { kind: "riskPercent", value: 0.01 }, stopLossPercent: 0.05 };
  }
  return { type: "hold" };
} })
`;
    expect(capabilities(source)).toContain("arithmetic");
  });
});
