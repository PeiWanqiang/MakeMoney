import { describe, expect, it } from "vitest";

import { sha256 } from "../src/internet-intents/pipeline.js";
import {
  buildGoldenCorpus,
  blindReviewQueueItem,
  calculateReviewAgreement,
  createReviewDraft,
  mergeReview,
  selectReviewQueue,
  selectAdjudicationQueue,
  splitForCandidate,
  validateReview,
  type InternetIntentAnnotation,
  type InternetIntentReview,
} from "../src/internet-intents/review.js";
import type { InternetIntentCandidate } from "../src/internet-intents/types.js";
import { readyContract } from "../src/semantics/contract.js";

const TEXT = "On 1h bars, enter long when RSI is below 30 and close when RSI is above 50.";

function candidate(
  id: string,
  options: Partial<Pick<InternetIntentCandidate, "source" | "language" | "repository">> & { author?: string; relevance?: "likely" | "possible" } = {},
): InternetIntentCandidate {
  return {
    schemaVersion: "1.0",
    id,
    source: options.source ?? "stackexchange",
    sourceRecordId: id,
    sourceUrl: `https://example.com/${id}`,
    sourceHost: "example.com",
    title: "RSI strategy",
    rawText: TEXT,
    rawSha256: sha256(TEXT),
    language: options.language ?? "en",
    publishedAt: null,
    fetchedAt: "2026-07-30T00:00:00.000Z",
    tags: ["rsi"],
    license: { id: "CC-BY-SA-4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/", attribution: "example" },
    author: { idHash: sha256(options.author ?? "author-1"), displayName: "example", profileUrl: null },
    relevance: { score: options.relevance === "possible" ? 0.4 : 0.8, status: options.relevance ?? "likely", signals: ["entry-action"] },
    reviewStatus: "unreviewed",
    repository: options.repository ?? null,
  };
}

function submittedReview(item: InternetIntentCandidate, reviewerId: string, kind: InternetIntentReview["kind"] = "review"): InternetIntentReview {
  const review = createReviewDraft(item, reviewerId, kind);
  const quote = "enter long when RSI is below 30";
  const start = item.rawText.indexOf(quote);
  return {
    ...review,
    status: "submitted",
    disposition: "ready",
    confidence: "high",
    evidence: [{ start, end: start + quote.length, quote, supports: ["long entry", "RSI below 30"] }],
    resolvedIntent: "On 1h bars, open long below RSI 30 and close above RSI 50.",
    contract: readyContract("1h", [
      {
        when: ["rsi(14)<30"],
        decision: { type: "open", side: "long", sizeKind: null, sizeValue: null, stopLossPercent: null, takeProfitRiskReward: null, closeFraction: null },
      },
      {
        when: ["rsi(14)>50"],
        decision: { type: "close", side: "long", sizeKind: null, sizeValue: null, stopLossPercent: null, takeProfitRiskReward: null, closeFraction: null },
      },
    ]),
    submittedAt: "2026-07-30T01:00:00.000Z",
  };
}

describe("internet intent review", () => {
  it("requires evidence to be an exact span of immutable candidate text", () => {
    const item = candidate("a");
    const valid = submittedReview(item, "reviewer-1");
    expect(validateReview(item, valid)).toEqual([]);
    const invalid = { ...valid, evidence: [{ ...valid.evidence[0]!, quote: "RSI crosses below 30" }] };
    expect(validateReview(item, invalid)).toContain("evidence[0].quote does not exactly match candidate rawText.");
  });

  it("rejects a ready label without a machine-checkable contract", () => {
    const item = candidate("b");
    const review = { ...submittedReview(item, "reviewer-1"), contract: null };
    expect(validateReview(item, review)).toContain("contract must be an object.");
  });

  it("stores independent reviews separately and requires adjudication by default", () => {
    const item = candidate("c");
    const first = submittedReview(item, "reviewer-1");
    const second = submittedReview(item, "reviewer-2");
    let annotation = mergeReview(item, undefined, first, "2026-07-30T01:00:00.000Z");
    annotation = mergeReview(item, annotation, second, "2026-07-30T02:00:00.000Z");
    expect(annotation.reviews).toHaveLength(2);
    expect(() => buildGoldenCorpus([item], [annotation])).toThrow(/requires adjudication/);

    const adjudication = {
      ...submittedReview(item, "adjudicator-1", "adjudication"),
      basedOnReviewIds: [first.reviewId, second.reviewId],
    };
    annotation = mergeReview(item, annotation, adjudication, "2026-07-30T03:00:00.000Z");
    const result = buildGoldenCorpus([item], [annotation], { now: "2026-07-30T04:00:00.000Z" });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.contract?.timeframe).toBe("1h");
    expect(result.manifest.minimumIndependentReviews).toBe(2);
  });

  it("allows an explicitly marked single-review pilot export", () => {
    const item = candidate("pilot");
    const annotation = mergeReview(item, undefined, submittedReview(item, "reviewer-1"));
    const result = buildGoldenCorpus([item], [annotation], {
      minimumIndependentReviews: 1,
      requireAdjudication: false,
      now: "2026-07-30T04:00:00.000Z",
    });
    expect(result.records).toHaveLength(1);
    expect(result.manifest.adjudicationRequired).toBe(false);
  });

  it("keeps every item from the same author or repository in one split", () => {
    const first = candidate("author-a", { author: "same-author" });
    const second = candidate("author-b", { author: "same-author" });
    expect(splitForCandidate(first)).toBe(splitForCandidate(second));

    const repository = { fullName: "owner/repo", defaultBranch: "main", filePath: "README.md" };
    const repoFirst = candidate("repo-a", { source: "github", author: "one", repository });
    const repoSecond = candidate("repo-b", { source: "github", author: "two", repository });
    expect(splitForCandidate(repoFirst)).toBe(splitForCandidate(repoSecond));
  });

  it("builds a stratified queue and skips work already reviewed by that reviewer", () => {
    const stack = candidate("stack", { relevance: "possible" });
    const github = candidate("github", { source: "github", repository: { fullName: "a/b", defaultBranch: "main", filePath: "README.md" } });
    const queue = selectReviewQueue([stack, github], [], { reviewerId: "reviewer-1", limit: 2 });
    expect(queue.map((item) => item.candidate.id).sort()).toEqual(["github", "stack"]);

    const reviewed: InternetIntentAnnotation = mergeReview(stack, undefined, submittedReview(stack, "reviewer-1"));
    const remaining = selectReviewQueue([stack, github], [reviewed], { reviewerId: "reviewer-1", limit: 2 });
    expect(remaining.map((item) => item.candidate.id)).toEqual(["github"]);
  });

  it("removes source, author, scoring and AI-adjacent metadata from blind packets", () => {
    const item = candidate("blind");
    const blind = blindReviewQueueItem({ candidate: item, review: createReviewDraft(item, "reviewer-a") });
    expect(Object.keys(blind.candidate).sort()).toEqual(["id", "language", "rawSha256", "rawText", "title"]);
    expect(blind.candidate).not.toHaveProperty("sourceUrl");
    expect(blind.candidate).not.toHaveProperty("author");
    expect(blind.candidate).not.toHaveProperty("relevance");
  });

  it("measures independent agreement and builds identity-blind adjudication cases", () => {
    const item = candidate("disputed");
    const first = submittedReview(item, "alice");
    const second = {
      ...submittedReview(item, "bob"),
      disposition: "needs_clarification" as const,
      resolvedIntent: null,
      contract: null,
      clarificationQuestions: ["Which position size should be used?"],
    };
    let annotation = mergeReview(item, undefined, first);
    annotation = mergeReview(item, annotation, second);
    expect(calculateReviewAgreement([annotation], "alice", "bob")).toMatchObject({
      paired: 1,
      dispositionAgreements: 0,
      exactDecisionAgreements: 0,
      cohensKappa: 0,
    });
    const queue = selectAdjudicationQueue([item], [annotation], "carol");
    expect(queue).toHaveLength(1);
    expect(queue[0]?.disputed).toBe(true);
    expect(queue[0]?.independentReviews.map((review) => review.reviewerAlias)).toEqual(["reviewer-1", "reviewer-2"]);
    expect(queue[0]?.independentReviews[0]).not.toHaveProperty("reviewerId");
    expect(queue[0]?.adjudication.basedOnReviewIds).toEqual([first.reviewId, second.reviewId].sort());
  });
});
