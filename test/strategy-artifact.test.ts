import { describe, expect, it } from "vitest";

import { parseStrategyModelArtifact } from "../src/studio/strategy-artifact.js";

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
});
