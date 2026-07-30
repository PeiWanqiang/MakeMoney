import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import { DeepSeekInternetIntentSuggestionProvider } from "../src/internet-intents/deepseek-suggestion-provider.js";
import { sha256 } from "../src/internet-intents/pipeline.js";
import {
  compareLaneSuggestions,
  parseSuggestionArtifact,
  segmentIntentText,
  type InternetIntentLaneSuggestion,
} from "../src/internet-intents/suggestions.js";
import type { InternetIntentCandidate } from "../src/internet-intents/types.js";

const RAW = "Enter long when RSI is below 30.\nrsiValue = ta.rsi(close, 14)\nif rsiValue < 30:\nstrategy.entry('L', strategy.long)";

function candidate(): InternetIntentCandidate {
  return {
    schemaVersion: "1.0",
    id: "candidate-1",
    source: "stackexchange",
    sourceRecordId: "1",
    sourceUrl: "https://example.com/1",
    sourceHost: "example.com",
    title: "RSI",
    rawText: RAW,
    rawSha256: sha256(RAW),
    language: "en",
    publishedAt: null,
    fetchedAt: "2026-07-30T00:00:00.000Z",
    tags: [],
    license: { id: "CC-BY-SA-4.0", url: "https://example.com/license", attribution: "author" },
    author: { idHash: sha256("author"), displayName: "author", profileUrl: null },
    relevance: { score: 0.8, status: "likely", signals: [] },
    reviewStatus: "unreviewed",
    repository: null,
  };
}

function lane(disposition: "ready" | "needs_clarification"): InternetIntentLaneSuggestion {
  return {
    lane: "prose",
    status: "completed",
    inputSha256: "hash",
    inputCharacters: 100,
    model: "fixture",
    responseId: "response",
    usage: null,
    artifact: {
      disposition,
      confidence: "high",
      evidence: [{ start: 0, end: 10, quote: "Enter long", supports: ["entry"] }],
      resolvedIntent: disposition === "ready" ? "RSI long" : null,
      contract: null,
      clarificationQuestions: disposition === "needs_clarification" ? ["Which timeframe?"] : [],
      unsupportedCapabilities: [],
      rationale: "fixture",
      assumptions: [],
    },
    error: null,
  };
}

describe("internet intent suggestions", () => {
  it("separates prose and recognizable strategy code deterministically", () => {
    const segments = segmentIntentText(RAW);
    expect(segments.prose).toBe("Enter long when RSI is below 30.");
    expect(segments.code).toContain("rsiValue = ta.rsi(close, 14)");
    expect(segments.codeLineCount).toBe(3);
  });

  it("accepts only verbatim evidence and review-compatible suggestion shapes", () => {
    const item = candidate();
    const valid = JSON.stringify({
      disposition: "needs_clarification",
      confidence: "high",
      evidence: [{ quote: "Enter long when RSI is below 30.", supports: ["long entry", "RSI threshold"] }],
      resolvedIntent: null,
      contract: null,
      clarificationQuestions: ["Which timeframe and position size should be used?"],
      unsupportedCapabilities: [],
      rationale: "Execution parameters are missing.",
      assumptions: [],
    });
    expect(parseSuggestionArtifact(item, valid).evidence[0]?.start).toBe(0);
    expect(() => parseSuggestionArtifact(item, valid.replace("Enter long", "Buy long"))).toThrow(/exact substring/);
  });

  it("reports lane conflicts instead of merging them", () => {
    const prose = lane("needs_clarification");
    const code = { ...lane("ready"), lane: "code" as const };
    const result = compareLaneSuggestions([prose, code]);
    expect(result.status).toBe("conflict");
    expect(result.diagnostics[0]?.code).toBe("LANE_DISPOSITION_CONFLICT");
  });

  it("retries provider output when an evidence quote is not verbatim", async () => {
    const artifact = {
      disposition: "not_strategy",
      confidence: "high",
      evidence: [{ quote: "Enter long when RSI is below 30.", supports: ["contains a rule fragment"] }],
      resolvedIntent: null,
      contract: null,
      clarificationQuestions: [],
      unsupportedCapabilities: [],
      rationale: "The isolated lane is not a complete strategy.",
      assumptions: [],
    };
    const create = vi.fn()
      .mockResolvedValueOnce({ id: "bad", model: "fixture", choices: [{ message: { content: JSON.stringify({ ...artifact, evidence: [{ quote: "Paraphrased evidence", supports: ["bad"] }] }) } }] })
      .mockResolvedValueOnce({ id: "good", model: "fixture", choices: [{ message: { content: JSON.stringify(artifact) } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const provider = new DeepSeekInternetIntentSuggestionProvider({ client, model: "fixture" });
    const result = await provider.suggest(candidate(), "prose", "Enter long when RSI is below 30.");
    expect(create).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "completed", responseId: "good", usage: { totalTokens: 30 } });
  });
});
