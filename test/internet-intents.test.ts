import { describe, expect, it } from "vitest";

import {
  deduplicateCandidates,
  detectLanguage,
  htmlToText,
  scoreIntentText,
  sha256,
} from "../src/internet-intents/pipeline.js";
import type { InternetIntentCandidate } from "../src/internet-intents/types.js";

function candidate(id: string, rawText: string, score = scoreIntentText(rawText).score): InternetIntentCandidate {
  return {
    schemaVersion: "1.0",
    id,
    source: "github",
    sourceRecordId: id,
    sourceUrl: `https://github.com/example/${id}`,
    sourceHost: "github.com",
    title: id,
    rawText,
    rawSha256: sha256(rawText),
    language: detectLanguage(rawText),
    publishedAt: null,
    fetchedAt: "2026-07-30T00:00:00.000Z",
    tags: [],
    license: { id: "MIT", url: "https://spdx.org/licenses/MIT.html", attribution: "example" },
    author: { idHash: sha256("author"), displayName: "example", profileUrl: null },
    relevance: { ...scoreIntentText(rawText), score },
    reviewStatus: "unreviewed",
    repository: null,
  };
}

describe("internet intent acquisition", () => {
  it("extracts readable Stack Exchange text", () => {
    expect(htmlToText("<p>Enter long when RSI &lt; 30.</p><pre>strategy.entry(&quot;L&quot;)</pre>"))
      .toBe('Enter long when RSI < 30.\nstrategy.entry("L")');
  });

  it("scores English and Chinese trading rules", () => {
    const english = scoreIntentText("On 1h bars, enter long when RSI is below 30 and exit with a stop loss.");
    const chinese = scoreIntentText("1小时 RSI 低于30时做多，高于50平仓，止损5%");
    expect(english.status).toBe("likely");
    expect(chinese.status).toBe("likely");
    expect(detectLanguage("Enter long 中文策略 when RSI低于30")).toBe("mixed");
  });

  it("removes exact and near-duplicate strategy descriptions", () => {
    const first = candidate("a", "Enter long when RSI is below 30 and exit when RSI is above 50 with a stop loss.", 0.9);
    const exact = candidate("b", first.rawText, 0.8);
    const near = candidate("c", "Enter long when RSI is below 30 and exit when RSI is above 50 with a stop loss today.", 0.7);
    const different = candidate("d", "Short when EMA 20 crosses below EMA 50 and close on the reverse cross.", 0.6);
    const result = deduplicateCandidates([different, exact, near, first], 0.7);
    expect(result.kept.map((item) => item.id)).toEqual(["a", "d"]);
    expect(result.removed).toHaveLength(2);
    expect(result.removed.map((item) => item.reason)).toEqual(expect.arrayContaining(["exact", "near"]));
  });
});
