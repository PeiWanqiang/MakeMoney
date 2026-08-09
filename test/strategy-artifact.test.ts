import { describe, expect, it } from "vitest";

import { parseStrategyModelArtifact, STRATEGY_OUTPUT_SCHEMA } from "../src/studio/strategy-artifact.js";

function artifact(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    status: "needs_clarification",
    source: "",
    contract: { schemaVersion: "1.0", timeframe: "1h", rules: [], unsupportedCapabilities: [] },
    clarificationQuestions: ["Which position size should be used?"],
    explanation: "More information is needed.",
    assumptions: [],
    warnings: [],
    changeSummary: "Initial request",
    ...overrides,
  });
}

describe("strategy model artifact triage", () => {
  it("keeps clarification questions separate from unsupported capabilities", () => {
    const parsed = parseStrategyModelArtifact(artifact({}));
    expect(parsed.status).toBe("needs_clarification");
    expect(parsed.clarificationQuestions).toEqual(["Which position size should be used?"]);
    expect(parsed.contract.unsupportedCapabilities).toEqual([]);
  });

  it("accepts a clear unsupported result without clarification questions", () => {
    const parsed = parseStrategyModelArtifact(artifact({
      status: "unsupported",
      clarificationQuestions: [],
      contract: { schemaVersion: "1.0", timeframe: "1h", rules: [], unsupportedCapabilities: ["options implied volatility"] },
    }));
    expect(parsed.status).toBe("unsupported");
    expect(parsed.contract.unsupportedCapabilities).toEqual(["options implied volatility"]);
  });

  it("rejects conflated clarification and unsupported outputs", () => {
    expect(() => parseStrategyModelArtifact(artifact({
      contract: { schemaVersion: "1.0", timeframe: "1h", rules: [], unsupportedCapabilities: ["unknown timeframe"] },
    }))).toThrow(/cannot contain unsupported capabilities/);
  });

  it("accepts equity-notional sizing and computed risk fields through the model boundary", () => {
    const parsed = parseStrategyModelArtifact(artifact({
      status: "ready",
      source: "defineStrategy({ id: 'fixture', name: 'fixture', version: 1, onBar() { return { type: 'hold' } } })",
      clarificationQuestions: [],
      contract: {
        schemaVersion: "1.0",
        timeframe: "15m",
        unsupportedCapabilities: [],
        rules: [{
          when: ['position.side == "flat"', 'market.close > ema("close",30,0)'],
          decision: {
            type: "open",
            side: "short",
            sizeKind: "equityPercent",
            sizeValue: 0.35,
            stopLossPercent: "atr(21,0)/market.close*1.5",
            takeProfitRiskReward: "2+0.5",
            closeFraction: null,
          },
        }],
      },
    }));

    expect(parsed.contract.rules[0]?.decision).toMatchObject({
      side: "short",
      sizeKind: "equityPercent",
      sizeValue: 0.35,
      stopLossPercent: "atr(21,0)/market.close*1.5",
      takeProfitRiskReward: "2+0.5",
    });
  });

  it("keeps the strict OpenAI schema aligned with every supported sizing and risk representation", () => {
    const rules = STRATEGY_OUTPUT_SCHEMA.properties.contract.properties.rules;
    const decision = rules.items.properties.decision.properties;
    expect(decision.sizeKind.enum).toEqual(["riskPercent", "equityPercent", "fixedNotional", null]);
    expect(decision.stopLossPercent.type).toContain("string");
    expect(decision.takeProfitRiskReward.type).toContain("string");
  });

  it("rejects empty computed risk fields and out-of-range percentage sizing", () => {
    const readyContract = (decision: Record<string, unknown>) => artifact({
      status: "ready",
      source: "defineStrategy({ id: 'fixture', name: 'fixture', version: 1, onBar() { return { type: 'hold' } } })",
      clarificationQuestions: [],
      contract: {
        schemaVersion: "1.0",
        timeframe: "1h",
        unsupportedCapabilities: [],
        rules: [{ when: ['position.side == "flat"'], decision }],
      },
    });
    const baseDecision = {
      type: "open", side: "long", sizeKind: "riskPercent", sizeValue: 0.01,
      stopLossPercent: 0.05, takeProfitRiskReward: null, closeFraction: null,
    };

    expect(() => parseStrategyModelArtifact(readyContract({ ...baseDecision, stopLossPercent: "   " })))
      .toThrow(/non-empty expression/);
    expect(() => parseStrategyModelArtifact(readyContract({ ...baseDecision, sizeKind: "equityPercent", sizeValue: 1.01 })))
      .toThrow(/at most one/);
  });
});
