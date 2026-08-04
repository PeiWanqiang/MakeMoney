import { describe, expect, it } from "vitest";

import { emaTrendStrategy } from "../examples/strategies.js";
import { buildServer } from "../services/backtest/app.js";
import type { ServiceBar } from "../src/contracts/index.js";
import { readyContract } from "../src/semantics/contract.js";
import { extractStrategySemantics } from "../src/semantics/extract-semantics.js";
import { extractParameterSchema } from "../src/optimization/parameter-discovery.js";

const H = 3_600_000;

function bars(count: number): ServiceBar[] {
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: count }, (_, index) => {
    const phase = index % 40;
    const close = 100 + (phase < 20 ? phase * 0.5 : (20 - phase) * 0.5) + index * 0.02;
    return { timestamp: start + index * H, open: close - 0.2, high: close + 0.3, low: close - 0.3, close, volume: 1000 };
  });
}

function contract() {
  return readyContract("4h", extractStrategySemantics(emaTrendStrategy).rules);
}

function fastPeriodId(): string {
  const definition = extractParameterSchema(contract()).find((item) => item.unit === "bars" && item.value === 20);
  if (!definition) throw new Error("no fast period parameter");
  return definition.id;
}

const CONFIG = { initialCapital: 10_000, takerFeeRate: 0.00045, slippageBps: 2, maxLeverage: 3 };

describe("optimization service endpoints", () => {
  it("POST /v1/optimization/run returns a full core result", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/v1/optimization/run",
      payload: {
        schemaVersion: "optimization-1.0",
        source: emaTrendStrategy,
        contract: contract(),
        selections: [{ id: fastPeriodId(), min: 10, max: 30, steps: 3 }],
        objective: "balanced",
        maximumTrials: 6,
        bars: bars(70),
        config: CONFIG,
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.schemaVersion).toBe("optimization-1.0");
    expect(body.result.schemaVersion).toBe("optimization-2.0");
    expect(body.result.trials.length).toBeGreaterThanOrEqual(2);
    expect(body.result.robustness.preBlindPassed).toBeTypeOf("boolean");
    await app.close();
  });

  it("POST /v1/optimization/run rejects an invalid selection", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/v1/optimization/run",
      payload: {
        schemaVersion: "optimization-1.0",
        source: emaTrendStrategy,
        contract: contract(),
        selections: [{ id: "rule.99.when.0.number.0", min: 1, max: 2, steps: 3 }],
        objective: "balanced",
        maximumTrials: 6,
        bars: bars(70),
        config: CONFIG,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "BAD_REQUEST" });
    await app.close();
  });

  it("POST /v1/optimization/materialize rewrites the real program", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/v1/optimization/materialize",
      payload: {
        schemaVersion: "materialize-1.0",
        source: emaTrendStrategy,
        contract: contract(),
        parameters: { [fastPeriodId()]: 30 },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.schemaVersion).toBe("materialize-1.0");
    expect(body.source).toContain('ema("close", 30)');
    expect(body.source).not.toBe(emaTrendStrategy);
    await app.close();
  });

  it("POST /v1/optimization/blind evaluates the frozen tail", async () => {
    const app = buildServer();
    const allBars = bars(70);
    const blindStartTime = allBars[56]!.timestamp;
    const response = await app.inject({
      method: "POST",
      url: "/v1/optimization/blind",
      payload: {
        schemaVersion: "blind-1.0",
        source: emaTrendStrategy,
        contract: contract(),
        candidateParameters: { [fastPeriodId()]: 30 },
        bars: allBars,
        config: CONFIG,
        blindStartTime,
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.schemaVersion).toBe("blind-1.0");
    expect(body.outcome.checks).toHaveLength(3);
    expect(typeof body.outcome.passed).toBe("boolean");
    await app.close();
  });
});
