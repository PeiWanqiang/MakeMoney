import OpenAI from "openai";

import { buildStrategyProviderInput, STRATEGY_GENERATOR_INSTRUCTIONS } from "./prompt.js";
import { parseStrategyModelArtifact } from "./strategy-artifact.js";
import type {
  StrategyProgramProvider,
  StrategyProviderRequest,
  StrategyProviderResponse,
} from "./types.js";

export interface DeepSeekStrategyProviderOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  maxOutputAttempts?: number;
  client?: OpenAI;
}

export function normalizeDeepSeekApiKey(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("sk-") ? trimmed : `sk-${trimmed}`;
}

export class DeepSeekStrategyProgramProvider implements StrategyProgramProvider {
  readonly model: string;
  private readonly client: OpenAI;
  private readonly maxOutputAttempts: number;

  constructor(options: DeepSeekStrategyProviderOptions = {}) {
    const rawApiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!options.client && !rawApiKey) {
      throw new Error("DEEPSEEK_API_KEY is required for the DeepSeek strategy provider.");
    }
    this.client = options.client ?? new OpenAI({
      apiKey: normalizeDeepSeekApiKey(rawApiKey as string),
      baseURL: options.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    });
    this.model = options.model
      ?? process.env.DEEPSEEK_STRATEGY_MODEL
      ?? process.env.STRATEGY_MODEL
      ?? "deepseek-v4-pro";
    this.maxOutputAttempts = options.maxOutputAttempts ?? 2;
    if (!Number.isInteger(this.maxOutputAttempts) || this.maxOutputAttempts < 1) {
      throw new Error("maxOutputAttempts must be a positive integer.");
    }
  }

  async generate(request: StrategyProviderRequest): Promise<StrategyProviderResponse> {
    let lastError: Error | undefined;
    for (let outputAttempt = 0; outputAttempt < this.maxOutputAttempts; outputAttempt += 1) {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: STRATEGY_GENERATOR_INSTRUCTIONS },
          {
            role: "user",
            content: `${buildStrategyProviderInput(request)}\n\nReturn one valid JSON object only.${
              outputAttempt === 0
                ? ""
                : " The previous response was empty or malformed; include every required field and no surrounding text."
            }`,
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 8_000,
        stream: false,
      });
      const choice = completion.choices[0];
      const content = choice?.message.content;
      if (choice?.finish_reason === "length") {
        lastError = new Error("DeepSeek strategy output was truncated at the token limit.");
        continue;
      }
      if (!content?.trim()) {
        lastError = new Error("DeepSeek returned empty JSON strategy output.");
        continue;
      }
      try {
        return {
          artifact: parseStrategyModelArtifact(content),
          provider: "deepseek",
          model: completion.model || this.model,
          responseId: completion.id,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("DeepSeek returned invalid strategy output.");
      }
    }
    throw lastError ?? new Error("DeepSeek did not return a strategy artifact.");
  }
}
