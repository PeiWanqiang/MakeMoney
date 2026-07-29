import { describe, expect, it } from "vitest";

import { GOLDEN_INTENT_COUNT, GOLDEN_STRATEGY_CASES } from "../src/semantics/golden-cases.js";
import { verifyStrategySemantics } from "../src/semantics/verify-semantics.js";

describe("golden strategy semantic corpus", () => {
  it("contains exactly 20 strategies and 100 bilingual intent expressions", () => {
    expect(GOLDEN_STRATEGY_CASES).toHaveLength(20);
    expect(GOLDEN_INTENT_COUNT).toBe(100);
    expect(GOLDEN_STRATEGY_CASES.every((item) => item.intents.length === 5)).toBe(true);
    expect(new Set(GOLDEN_STRATEGY_CASES.map((item) => item.id)).size).toBe(20);
  });

  it("passes reverse extraction and behavior scenarios for every golden program", async () => {
    for (const item of GOLDEN_STRATEGY_CASES) {
      const report = await verifyStrategySemantics(item.source, item.contract);
      expect(report.ok, `${item.id}: ${JSON.stringify(report.diagnostics)}`).toBe(true);
    }
  });
});
