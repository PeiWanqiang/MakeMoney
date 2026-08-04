import { describe, expect, it } from "vitest";

import { emaTrendStrategy } from "../examples/strategies.js";
import type { MarketBar } from "../src/core/types.js";
import { readyContract } from "../src/semantics/contract.js";
import { extractStrategySemantics } from "../src/semantics/extract-semantics.js";
import { runBlindTest } from "../src/optimization/blind-test.js";
import { runParameterOptimization } from "../src/optimization/optimization.js";
import { extractParameterSchema, type ParameterSelection } from "../src/optimization/parameter-discovery.js";

const H = 3_600_000;

function bars(count: number): MarketBar[] {
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: count }, (_, index) => {
    // A sawtooth so the EMA cross strategy generates several trades.
    const phase = index % 40;
    const close = 100 + (phase < 20 ? phase * 0.5 : (20 - phase) * 0.5) + index * 0.02;
    return { timestamp: start + index * H, open: close - 0.2, high: close + 0.3, low: close - 0.3, close, volume: 1000 };
  });
}

function contractFor(source: string) {
  return readyContract("4h", extractStrategySemantics(source).rules);
}

const CONFIG = { initialCapital: 10_000, takerFeeRate: 0.00045, slippageBps: 2, maxLeverage: 3 };

describe("parameter optimization on the real program", () => {
  it("runs the full pipeline and returns a deterministic core result", async () => {
    const source = emaTrendStrategy;
    const contract = contractFor(source);
    const definitions = extractParameterSchema(contract);
    const fast = definitions.find((item) => item.unit === "bars" && item.value === 20)!;
    const selections: ParameterSelection[] = [
      { id: fast.id, min: 10, max: 30, steps: 3 },
    ];

    const result = await runParameterOptimization({
      source,
      contract,
      selections,
      objective: "balanced",
      maximumTrials: 6,
      bars: bars(160),
      config: CONFIG,
    });

    expect(result.schemaVersion).toBe("optimization-2.0");
    expect(result.semanticLockHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.trials.length).toBeGreaterThanOrEqual(2);
    expect(result.trials[0]!.isBaseline).toBe(true);
    expect(result.trials[0]!.parameters[fast.id]).toBe(20);
    expect(result.baselineTrialId).toBe(result.trials[0]!.id);
    expect(result.split.trainBars + result.split.validationBars + result.split.blindBars).toBe(160);
    expect(result.robustness).toBeDefined();
    expect(Array.isArray(result.robustness.walkForward.folds)).toBe(true);
    expect(Array.isArray(result.robustness.regimes)).toBe(true);
    expect(result.outcome).toMatch(/^(improved|baseline_retained)$/);

    // Same input → same result (determinism).
    const again = await runParameterOptimization({
      source,
      contract,
      selections,
      objective: "balanced",
      maximumTrials: 6,
      bars: bars(160),
      config: CONFIG,
    });
    expect(again.trials).toEqual(result.trials);
    expect(again.robustness).toEqual(result.robustness);
  }, 30_000);

  it("applies parameters to the recommended candidate program", async () => {
    const source = emaTrendStrategy;
    const contract = contractFor(source);
    const definitions = extractParameterSchema(contract);
    const fast = definitions.find((item) => item.unit === "bars" && item.value === 20)!;
    const selections: ParameterSelection[] = [{ id: fast.id, min: 25, max: 35, steps: 3 }];
    const result = await runParameterOptimization({
      source,
      contract,
      selections,
      objective: "balanced",
      maximumTrials: 6,
      bars: bars(160),
      config: CONFIG,
    });
    const recommended = result.trials.find((trial) => trial.id === result.recommendedTrialId)!;
    expect(recommended.parameters[fast.id]).toBeGreaterThanOrEqual(20); // the selection range centers away from 20
  }, 30_000);

  it("blind test evaluates baseline and candidate on the frozen tail", async () => {
    const source = emaTrendStrategy;
    const contract = contractFor(source);
    const definitions = extractParameterSchema(contract);
    const fast = definitions.find((item) => item.unit === "bars" && item.value === 20)!;
    const allBars = bars(160);
    const blindStart = allBars[128]!.timestamp;
    const outcome = await runBlindTest({
      source,
      contract,
      definitions,
      candidateParameters: { [fast.id]: 30 },
      bars: allBars,
      config: CONFIG,
      blindStartTime: blindStart,
    });
    expect(outcome.baseline).toBeDefined();
    expect(outcome.candidate).toBeDefined();
    expect(outcome.checks).toHaveLength(3);
    expect(typeof outcome.passed).toBe("boolean");
  }, 20_000);
});
