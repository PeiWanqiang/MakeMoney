import OpenAI from "openai";

import { buildStrategyProviderInput, STRATEGY_GENERATOR_INSTRUCTIONS } from "./prompt.js";
import { parseStrategyModelArtifact } from "./strategy-artifact.js";
import type {
  ProviderTokenUsage,
  StrategyProgramProvider,
  StrategyProviderRequest,
  StrategyProviderResponse,
} from "./types.js";

function completionUsage(value: unknown): ProviderTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  const totalTokens = usage.total_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number" || typeof totalTokens !== "number") return undefined;
  const promptDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details as Record<string, unknown>
    : undefined;
  const completionDetails = usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
    ? usage.completion_tokens_details as Record<string, unknown>
    : undefined;
  const cached = typeof usage.prompt_cache_hit_tokens === "number"
    ? usage.prompt_cache_hit_tokens
    : typeof promptDetails?.cached_tokens === "number" ? promptDetails.cached_tokens : undefined;
  const explicitUncached = typeof usage.prompt_cache_miss_tokens === "number" ? usage.prompt_cache_miss_tokens : undefined;
  const reasoning = typeof completionDetails?.reasoning_tokens === "number" ? completionDetails.reasoning_tokens : undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(explicitUncached === undefined && cached === undefined ? {} : { uncachedInputTokens: explicitUncached ?? Math.max(0, inputTokens - (cached ?? 0)) }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

function addUsage(left: ProviderTokenUsage | undefined, right: ProviderTokenUsage | undefined): ProviderTokenUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  const optionalSum = (field: "cachedInputTokens" | "uncachedInputTokens" | "reasoningTokens"): number | undefined => {
    const a = left[field];
    const b = right[field];
    return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  };
  const cachedInputTokens = optionalSum("cachedInputTokens");
  const uncachedInputTokens = optionalSum("uncachedInputTokens");
  const reasoningTokens = optionalSum("reasoningTokens");
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

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
    let accumulatedUsage: ProviderTokenUsage | undefined;
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
                : ` The previous response was empty or malformed. Parser error: ${lastError?.message ?? "unknown format error"}. Include every required field and no surrounding text. For close decisions side, sizeKind, sizeValue, stopLossPercent, and takeProfitRiskReward must all be null.`
            }`,
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 8_000,
        stream: false,
      });
      accumulatedUsage = addUsage(accumulatedUsage, completionUsage(completion.usage));
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
          ...(accumulatedUsage === undefined ? {} : { usage: accumulatedUsage }),
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("DeepSeek returned invalid strategy output.");
      }
    }
    throw lastError ?? new Error("DeepSeek did not return a strategy artifact.");
  }
}
