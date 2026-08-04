import { describe, expect, it } from "vitest";

import { emaFundingStrategy, emaTrendStrategy } from "../examples/strategies.js";
import { buildServer } from "../services/backtest/app.js";
import type { ServiceBar } from "../src/contracts/index.js";

const H = 3_600_000;

function bars(closeSeries: number[], fundingRate?: number): ServiceBar[] {
  const start = Date.UTC(2026, 0, 1);
  return closeSeries.map((close, index) => ({
    timestamp: start + index * H,
    open: close - 0.2,
    high: close + 0.3,
    low: close - 0.3,
    close,
    volume: 1000,
    ...(fundingRate !== undefined ? { fundingRate } : {}),
  }));
}

const FUNDING_SOURCE = `
defineStrategy({
  id: "golden.funding",
  name: "Negative funding gate",
  version: 1,
  onBar(ctx) {
    if (ctx.position.side === "flat" && ctx.market.fundingRate < 0) {
      return { type: "open", side: "long", size: { kind: "equityPercent", value: 0.5 }, stopLossPercent: 0.05, takeProfitRiskReward: 2, reason: "negative funding" };
    }
    return { type: "hold" };
  }
})
`;

const FUNDING_CONTRACT = {
  schemaVersion: "1.0",
  timeframe: "1h",
  rules: [
    {
      when: ['position.side == "flat"', 'market.fundingRate < 0'],
      decision: {
        type: "open",
        side: "long",
        sizeKind: "equityPercent",
        sizeValue: 0.5,
        stopLossPercent: 0.05,
        takeProfitRiskReward: 2,
      },
    },
  ],
  unsupportedCapabilities: [],
} as const;

describe("backtest service", () => {
  it("healthz reports the engine", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, engine: "quickjs-cli" });
    await app.close();
  });

  it("POST /v1/backtest runs a real program and returns metrics", async () => {
    const app = buildServer();
    const closeSeries = Array.from({ length: 150 }, (_, index) =>
      index < 50 ? 100 : index < 95 ? 100 + (index - 50) * 0.5 : 147.5 - (index - 95) * 0.5,
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      payload: {
        schemaVersion: "backtest-1.0",
        source: emaTrendStrategy,
        bars: bars(closeSeries),
        config: { initialCapital: 10_000, takerFeeRate: 0.00045, slippageBps: 2, maxLeverage: 3 },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.schemaVersion).toBe("backtest-1.0");
    expect(body.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.strategy.programHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.initialCapital).toBe(10_000);
    expect(body.metrics.tradeCount).toBe(1);
    expect(body.finalEquity).toBeCloseTo(10463.2742, 3);
    expect(body.equityCurve).toHaveLength(150);
    await app.close();
  });

  it("POST /v1/backtest runs the golden funding strategy with funding PnL", async () => {
    const app = buildServer();
    const closeSeries = Array.from({ length: 120 }, (_, index) =>
      index < 40 ? 100 : index < 85 ? 100 + (index - 40) * 0.5 : 122.5 - (index - 85) * 0.5,
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      payload: {
        schemaVersion: "backtest-1.0",
        source: emaFundingStrategy,
        bars: bars(closeSeries, -0.0001),
        config: { initialCapital: 10_000, takerFeeRate: 0.00045, slippageBps: 2, maxLeverage: 3 },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.metrics.tradeCount).toBe(1);
    expect(body.metrics.fundingPnl).toBeCloseTo(4.5973, 3);
    expect(body.trades[0]).toMatchObject({ exitReason: "takeProfit", side: "long" });
    await app.close();
  });

  it("POST /v1/backtest accepts equityPercent sizing", async () => {
    const app = buildServer();
    // A gentle rise (3% total) stays inside the 10% take-profit, so the single
    // opening holds to the end of the data.
    const closeSeries = Array.from({ length: 60 }, (_, index) => 100 + index * 0.05);
    const response = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      payload: {
        schemaVersion: "backtest-1.0",
        source: FUNDING_SOURCE,
        bars: bars(closeSeries, -0.0001),
        config: { initialCapital: 10_000, takerFeeRate: 0.00045, slippageBps: 2, maxLeverage: 3 },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Opens on the first bar (flat + negative funding) and holds to the end.
    expect(body.metrics.tradeCount).toBe(1);
    expect(body.trades[0]).toMatchObject({ side: "long", exitReason: "endOfData" });
    expect(body.finalEquity).toBeGreaterThan(body.initialCapital);
    await app.close();
  });

  it("POST /v1/backtest rejects invalid source with COMPILE_FAILED", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      payload: {
        schemaVersion: "backtest-1.0",
        source: "defineStrategy({ id: 1, name: 2, version: 3, onBar(ctx) { return { type: \"hold\" } } })",
        bars: bars([100, 101, 102]),
        config: { initialCapital: 10_000, takerFeeRate: 0.00045, slippageBps: 2, maxLeverage: 3 },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ schemaVersion: "error-1.0", code: "COMPILE_FAILED" });
    await app.close();
  });

  it("POST /v1/strategy/verify passes a program/contract pair that match", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/v1/strategy/verify",
      payload: {
        schemaVersion: "verify-1.0",
        source: FUNDING_SOURCE,
        contract: FUNDING_CONTRACT,
        availableCapabilities: ["ohlcv", "fundingRate", "indicators", "multiTimeframe", "state", "arithmetic"],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.compiled.ok).toBe(true);
    expect(body.semantics.ok).toBe(true);
    expect(body.capabilities.used).toContain("fundingRate");
    expect(body.capabilities.unsupported).toEqual([]);
    await app.close();
  });

  it("POST /v1/strategy/verify reports funding as unsupported when the caller lacks it", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/v1/strategy/verify",
      payload: {
        schemaVersion: "verify-1.0",
        source: FUNDING_SOURCE,
        contract: FUNDING_CONTRACT,
        availableCapabilities: ["ohlcv", "indicators", "multiTimeframe", "state", "arithmetic"],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.capabilities.unsupported).toContain("fundingRate");
    expect(body.diagnostics.some((item: { code: string }) => item.code === "UNSUPPORTED_CAPABILITY")).toBe(true);
    await app.close();
  });

  it("POST /v1/strategy/verify rejects a program whose contract rules do not match", async () => {
    const app = buildServer();
    const contract = {
      ...FUNDING_CONTRACT,
      rules: [
        {
          when: ['position.side == "flat"'],
          decision: { type: "close", side: null, sizeKind: null, sizeValue: null, stopLossPercent: null, takeProfitRiskReward: null },
        },
      ],
    };
    const response = await app.inject({
      method: "POST",
      url: "/v1/strategy/verify",
      payload: { schemaVersion: "verify-1.0", source: FUNDING_SOURCE, contract },
    });
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.compiled.ok).toBe(true);
    expect(body.diagnostics.some((item: { code: string }) => item.code === "MISSING_CONTRACT_RULE")).toBe(true);
    await app.close();
  });
});
