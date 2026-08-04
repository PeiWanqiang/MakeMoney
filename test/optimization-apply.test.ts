import { describe, expect, it } from "vitest";

import { emaTrendStrategy, thresholdStrategy } from "../examples/strategies.js";
import { compileStrategySource } from "../src/compiler/compile-strategy-source.js";
import type { MarketBar } from "../src/core/types.js";
import { readyContract } from "../src/semantics/contract.js";
import { extractStrategySemantics } from "../src/semantics/extract-semantics.js";
import { runBacktest } from "../src/runtime/backtest.js";
import { applyParameters, extractParameterSchema, semanticSkeleton } from "../src/optimization/parameter-discovery.js";
import { applyParametersToSource } from "../src/optimization/program-apply.js";

const H = 3_600_000;

function contractFor(source: string) {
  return readyContract("4h", extractStrategySemantics(source).rules);
}

function bars(count: number): MarketBar[] {
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.2;
    return { timestamp: start + index * H, open: close - 0.2, high: close + 0.3, low: close - 0.3, close, volume: 1000 };
  });
}

describe("parameter discovery and program application", () => {
  it("discovers period, threshold and decision parameters from the contract", () => {
    const contract = contractFor(emaTrendStrategy);
    const definitions = extractParameterSchema(contract);
    const periods = definitions.filter((item) => item.unit === "bars");
    expect(periods.some((item) => item.value === 20)).toBe(true);
    expect(periods.some((item) => item.value === 50)).toBe(true);
    expect(definitions.some((item) => item.id.endsWith("decision.stopLossPercent"))).toBe(true);
    expect(definitions.some((item) => item.id.endsWith("decision.sizeValue"))).toBe(true);
  });

  it("applies an EMA period change to the hoisted variable declaration", async () => {
    const contract = contractFor(emaTrendStrategy);
    const definitions = extractParameterSchema(contract);
    const fastPeriod = definitions.find((item) => item.unit === "bars" && item.value === 20);
    expect(fastPeriod).toBeDefined();

    const modified = applyParametersToSource(emaTrendStrategy, contract, definitions, { [fastPeriod!.id]: 30 });
    expect(modified).not.toBe(emaTrendStrategy);
    compileStrategySource(modified); // still compiles

    const conditions = extractStrategySemantics(modified).rules.flatMap((rule) => rule.when);
    expect(conditions.some((condition) => condition.includes('ema("close",30,0)'))).toBe(true);
    expect(conditions.some((condition) => condition.includes('ema("close",50,0)'))).toBe(true);

    // The modified program executes.
    const result = await runBacktest(modified, bars(150));
    expect(result.equityCurve).toHaveLength(150);
  });

  it("applies a stop-loss decision field change to the return object", async () => {
    const contract = contractFor(emaTrendStrategy);
    const definitions = extractParameterSchema(contract);
    const stop = definitions.find((item) => item.id.endsWith("decision.stopLossPercent"));
    expect(stop).toBeDefined();

    const modified = applyParametersToSource(emaTrendStrategy, contract, definitions, { [stop!.id]: 0.03 });
    compileStrategySource(modified);
    const decision = extractStrategySemantics(modified).rules.find((rule) => rule.decision.type === "open");
    expect(decision?.decision.stopLossPercent).toBe(0.03);
  });

  it("contract apply and program apply produce consistent semantics", () => {
    const contract = contractFor(emaTrendStrategy);
    const definitions = extractParameterSchema(contract);
    const fastPeriod = definitions.find((item) => item.unit === "bars" && item.value === 20)!;

    const appliedContract = applyParameters(contract, definitions, { [fastPeriod.id]: 30 });
    const appliedProgram = applyParametersToSource(emaTrendStrategy, contract, definitions, { [fastPeriod.id]: 30 });

    // Both sides expose ema("close",30,0) in their canonical conditions.
    const contractConditions = appliedContract.rules.flatMap((rule) => rule.when);
    const programConditions = extractStrategySemantics(appliedProgram).rules.flatMap((rule) => rule.when);
    expect(contractConditions.some((condition) => condition.includes('ema("close",30,0)'))).toBe(true);
    expect(programConditions.some((condition) => condition.includes('ema("close",30,0)'))).toBe(true);
    // The semantic lock is unchanged: only numbers moved, structure is identical.
    expect(semanticSkeleton(appliedContract)).toBe(semanticSkeleton(contract));
  });

  it("unchanged values rewrite nothing", () => {
    const contract = contractFor(emaTrendStrategy);
    const definitions = extractParameterSchema(contract);
    const values = Object.fromEntries(definitions.map((item) => [item.id, item.value]));
    const modified = applyParametersToSource(emaTrendStrategy, contract, definitions, values);
    expect(modified).toBe(emaTrendStrategy);
  });

  it("a stateful threshold strategy applies a threshold change", async () => {
    const contract = contractFor(thresholdStrategy);
    const definitions = extractParameterSchema(contract);
    // Entry condition has close >= 101; the 101 is a tunable condition number.
    const entryThreshold = definitions.find((item) => item.value === 101 && item.id.startsWith("rule.0.when."));
    expect(entryThreshold).toBeDefined();
    const modified = applyParametersToSource(thresholdStrategy, contract, definitions, { [entryThreshold!.id]: 103 });
    compileStrategySource(modified);
    const result = await runBacktest(modified, bars(60));
    expect(result.equityCurve).toHaveLength(60);
  });
});
