import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import { OpenAIStrategyProgramProvider } from "../src/studio/openai-provider.js";
import { thresholdStrategy } from "../examples/strategies.js";

describe("OpenAI strategy provider", () => {
  it("uses strict structured output without storing API response state", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "resp_fixture",
      output_text: JSON.stringify({
        status: "ready",
        source: thresholdStrategy,
        contract: { schemaVersion: "1.0", timeframe: "4h", rules: [], unsupportedCapabilities: [] },
        clarificationQuestions: [],
        explanation: "Threshold entry and exit.",
        assumptions: ["One-hour closed bars."],
        warnings: [],
        changeSummary: "Initial version",
      }),
    });
    const client = { responses: { create } } as unknown as OpenAI;
    const provider = new OpenAIStrategyProgramProvider({ client, model: "fixture-model", reasoningEffort: "low" });

    const result = await provider.generate({
      mode: "create",
      sessionId: "private-user-session",
      userIntent: "收盘价达到 101 时做多",
      originalIntent: "收盘价达到 101 时做多",
      attempt: 0,
    });

    expect(result).toMatchObject({ provider: "openai", model: "fixture-model", responseId: "resp_fixture" });
    expect(result.artifact.source).toBe(thresholdStrategy);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: "fixture-model",
      store: false,
      reasoning: { effort: "low" },
      safety_identifier: expect.stringMatching(/^strategy_[a-f0-9]{32}$/),
      text: expect.objectContaining({
        format: expect.objectContaining({ type: "json_schema", strict: true }),
      }),
    }));
    const request = create.mock.calls[0]?.[0] as { input?: string; instructions?: string };
    expect(request.input).toContain("收盘价达到 101 时做多");
    expect(request.instructions).toContain("declare function defineStrategy");
  });
});
