import { describe, expect, it } from "vitest";

import { validateStrategySource } from "../src/compiler/validate-strategy-source.js";
import { thresholdStrategy } from "../examples/strategies.js";

describe("strategy source validation", () => {
  it("accepts a bounded strategy program", () => {
    expect(validateStrategySource(thresholdStrategy)).toEqual({ ok: true, diagnostics: [] });
  });

  it.each([
    ["network", `defineStrategy({ id: "x", name: "x", version: 1, onBar() { fetch("https://example.com"); return { type: "hold" }; } })`],
    ["clock", `defineStrategy({ id: "x", name: "x", version: 1, onBar() { const now = Date.now(); return { type: "hold", reason: String(now) }; } })`],
    ["loop", `defineStrategy({ id: "x", name: "x", version: 1, onBar() { while (true) {} } })`],
    ["escape", `defineStrategy({ id: "x", name: "x", version: 1, onBar(ctx) { return ctx.constructor.constructor("return process")(); } })`],
  ])("rejects forbidden %s access", (_name, source) => {
    const result = validateStrategySource(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("rejects extra top-level code", () => {
    const result = validateStrategySource(`const secret = 1; ${thresholdStrategy}`);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((item) => item.code === "INVALID_PROGRAM_SHAPE")).toBe(true);
  });
});

