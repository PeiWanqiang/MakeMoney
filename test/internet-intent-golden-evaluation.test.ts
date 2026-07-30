import { describe, expect, it } from "vitest";

import { assessGoldenOutcome } from "../src/internet-intents/golden-evaluation.js";
import type { InternetIntentGoldenRecord } from "../src/internet-intents/review.js";
import { readyContract } from "../src/semantics/contract.js";

const contract = readyContract("1h", [{
  when: ['rsi("close",14,0) < 30'],
  decision: { type: "open", side: "long", sizeKind: "riskPercent", sizeValue: 0.01, stopLossPercent: 0.05, takeProfitRiskReward: null },
}]);

function golden(action: InternetIntentGoldenRecord["expectedFirstAction"]): InternetIntentGoldenRecord {
  return {
    schemaVersion: "1.0",
    id: "gold-1",
    candidateId: "candidate-1",
    split: "development",
    source: "stackexchange",
    sourceUrl: "https://example.com/1",
    sourceRecordId: "1",
    language: "en",
    license: { id: "CC-BY-SA-4.0", url: "https://example.com/license", attribution: "author" },
    authorGroupHash: "author-hash",
    rawIntent: "RSI below 30",
    rawSha256: "raw-hash",
    expectedFirstAction: action,
    confidence: "high",
    evidence: [{ start: 0, end: 12, quote: "RSI below 30", supports: ["entry"] }],
    resolvedIntent: action === "ready" ? "Long below RSI 30" : null,
    contract: action === "ready" ? contract : null,
    clarificationQuestions: action === "needs_clarification" ? ["Which timeframe?"] : [],
    unsupportedCapabilities: action === "unsupported" ? ["options volatility"] : [],
    annotationId: "annotation-1",
    resolutionReviewId: "adjudication-1",
  };
}

describe("real intent golden outcome assessment", () => {
  it("requires action, contract, semantic verification and mutation killing for ready intents", () => {
    expect(assessGoldenOutcome(golden("ready"), {
      action: "ready",
      contract,
      semanticVerified: true,
      mutationKillRate: 1,
    })).toMatchObject({ status: "passed", strictPassed: true });
  });

  it("does not call clarification wording correct without human assessment", () => {
    expect(assessGoldenOutcome(golden("needs_clarification"), {
      action: "needs_clarification",
      contract: null,
      semanticVerified: false,
      mutationKillRate: null,
    })).toMatchObject({ status: "action_matched_manual_review_required", actionMatched: true, strictPassed: false, requiresManualReview: true });
  });

  it("reports unsupported versus clarification as a first-action mismatch", () => {
    expect(assessGoldenOutcome(golden("unsupported"), {
      action: "needs_clarification",
      contract: null,
      semanticVerified: false,
      mutationKillRate: null,
    })).toMatchObject({ status: "first_action_mismatch", actionMatched: false });
  });
});
