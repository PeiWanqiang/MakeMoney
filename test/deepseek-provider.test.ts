import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import { thresholdStrategy } from "../examples/strategies.js";
import { DeepSeekStrategyProgramProvider, normalizeDeepSeekApiKey } from "../src/studio/deepseek-provider.js";

describe("DeepSeek strategy provider", () => {
  it("normalizes a key body without persisting or exposing it", () => {
    expect(normalizeDeepSeekApiKey("abc123")).toBe("sk-abc123");
    expect(normalizeDeepSeekApiKey("  sk-abc123  ")).toBe("sk-abc123");
  });

  it("uses OpenAI-compatible JSON Output and retries an empty response once", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        id: "deepseek_empty",
        model: "deepseek-v4-pro",
        choices: [{ finish_reason: "stop", message: { content: "" } }],
      })
      .mockResolvedValueOnce({
        id: "deepseek_valid",
        model: "deepseek-v4-pro",
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              source: thresholdStrategy,
              explanation: "Threshold entry and exit.",
              assumptions: ["Closed bars."],
              warnings: [],
              changeSummary: "Initial version",
            }),
          },
        }],
      });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const provider = new DeepSeekStrategyProgramProvider({ client, model: "deepseek-v4-pro" });

    const result = await provider.generate({
      mode: "create",
      sessionId: "deepseek-session",
      userIntent: "价格达到 101 做多",
      originalIntent: "价格达到 101 做多",
      attempt: 0,
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({
      model: "deepseek-v4-pro",
      response_format: { type: "json_object" },
      max_tokens: 8_000,
      stream: false,
    }));
    expect(result).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      responseId: "deepseek_valid",
    });
    expect(result.artifact.source).toBe(thresholdStrategy);
  });
});
