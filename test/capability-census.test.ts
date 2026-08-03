import { describe, expect, it } from "vitest";

import { buildCensusReport, type CensusObservation } from "../src/internet-intents/capability-census.js";

function observation(overrides: Partial<CensusObservation> & { candidateId: string }): CensusObservation {
  return {
    schemaVersion: "1.0",
    candidateSha256: `sha-${overrides.candidateId}`,
    fingerprint: `fp-${overrides.candidateId}`,
    generator: "test",
    observedAt: "2026-08-02T00:00:00.000Z",
    sourceHost: "example.com",
    sourceUrl: "https://example.com/1",
    language: "en",
    relevanceScore: 1,
    intentChars: 100,
    intentTruncated: false,
    outcome: "ready",
    opaqueConditions: [],
    unsupportedCapabilities: [],
    clarificationQuestions: [],
    repairCount: 0,
    durationMs: 1,
    error: null,
    ...overrides,
  };
}

describe("capability gap census", () => {
  it("counts outcomes and gap-bearing candidates", () => {
    const report = buildCensusReport([
      observation({ candidateId: "a", outcome: "ready", opaqueConditions: ["closes.every(c => c > boxHigh)"] }),
      observation({ candidateId: "b", outcome: "unsupported", unsupportedCapabilities: ["Dynamic stop loss"] }),
      observation({ candidateId: "c", outcome: "needs_clarification", clarificationQuestions: ["Which timeframe?"] }),
      observation({ candidateId: "d", outcome: "engine_error", error: "boom" }),
    ]);

    expect(report.summary.observations).toBe(4);
    expect(report.summary.byOutcome).toEqual({
      ready: 1,
      needs_clarification: 1,
      unsupported: 1,
      generation_error: 0,
      engine_error: 1,
    });
    expect(report.summary.candidatesWithOpaqueConditions).toBe(1);
    expect(report.summary.candidatesWithUnsupportedCapabilities).toBe(1);
  });

  it("ranks an opaque condition shared by several candidates above a one-off", () => {
    const shared = "closes.every(value => value > boxHigh)";
    const report = buildCensusReport([
      observation({ candidateId: "a", opaqueConditions: [shared] }),
      observation({ candidateId: "b", opaqueConditions: [`  ${shared}  `] }),
      observation({ candidateId: "c", opaqueConditions: ["someOtherThing(1)"] }),
    ]);

    expect(report.opaqueConditions[0]).toMatchObject({ value: shared, candidates: 2 });
    expect(report.opaqueConditions[1]?.candidates).toBe(1);
  });

  it("keeps distinct opaque expressions separate rather than merging them", () => {
    const report = buildCensusReport([
      observation({ candidateId: "a", opaqueConditions: ["highs.every(v => v > top)"] }),
      observation({ candidateId: "b", opaqueConditions: ["lows.every(v => v < bottom)"] }),
    ]);

    expect(report.opaqueConditions).toHaveLength(2);
  });

  it("groups the same capability described with different constants into one phrase", () => {
    const report = buildCensusReport([
      observation({ candidateId: "a", unsupportedCapabilities: ["Consecutive bar confirmation over 3 bars"] }),
      observation({ candidateId: "b", unsupportedCapabilities: ["consecutive bar confirmation over 5 bars"] }),
    ]);

    const phrase = report.unsupportedCapabilityPhrases.find((item) => item.value === "consecutive bar confirmation");
    expect(phrase).toMatchObject({ candidates: 2 });
    // The exact-string view must still show them apart, so nothing is hidden by normalisation.
    expect(report.unsupportedCapabilities).toHaveLength(2);
  });

  it("drops phrases that appear in only one candidate", () => {
    const report = buildCensusReport([
      observation({ candidateId: "a", unsupportedCapabilities: ["a singular unrepeated capability"] }),
      observation({ candidateId: "b", unsupportedCapabilities: ["dynamic stop placement"] }),
      observation({ candidateId: "c", unsupportedCapabilities: ["dynamic stop placement"] }),
    ]);

    expect(report.unsupportedCapabilityPhrases.every((item) => item.candidates >= 2)).toBe(true);
    expect(report.unsupportedCapabilityPhrases.some((item) => item.value === "dynamic stop")).toBe(true);
  });

  it("counts a candidate once per gap even when it repeats the phrase", () => {
    const report = buildCensusReport([
      observation({ candidateId: "a", unsupportedCapabilities: ["trailing stop", "trailing stop support"] }),
      observation({ candidateId: "b", unsupportedCapabilities: ["trailing stop"] }),
    ]);

    const phrase = report.unsupportedCapabilityPhrases.find((item) => item.value === "trailing stop");
    expect(phrase).toMatchObject({ candidates: 2, occurrences: 3 });
  });
});
