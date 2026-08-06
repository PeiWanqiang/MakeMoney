import OpenAI from "openai";

import { normalizeDeepSeekApiKey } from "../studio/deepseek-provider.js";
import { parseSuggestionArtifact, type InternetIntentLaneSuggestion, type InternetIntentSuggestionLane } from "./suggestions.js";
import { sha256 } from "./pipeline.js";
import type { InternetIntentCandidate } from "./types.js";

const INSTRUCTIONS = `
You are producing a non-authoritative reviewer aid for a corpus of real public trading-strategy discussions.
Analyze only the supplied lane. Do not answer the user's question, debug code, optimize a strategy, or invent missing rules.

Classify it as:
- ready: the lane itself gives an unambiguous, executable strategy meaning;
- needs_clarification: it is a strategy but execution-critical facts are missing or ambiguous;
- unsupported: the requested meaning is clear but outside the supplied audit contract capabilities;
- not_strategy: it is generic framework/product/research text or contains no concrete user strategy intent.

The audit contract supports evaluation timeframes 1m, 15m, 1h, 4h, 1d and 1w; closed-bar OHLCV, funding rate and open interest; SMA, EMA, RSI, MACD, ATR, Bollinger Bands, highest/lowest, percent change and multi-timeframe views; long/short open and close; fixed-notional or risk-percent sizing; percentage stop loss and risk/reward take profit.

Rules:
- treat prose and code as evidence, not as permission to infer missing intent;
- distinguish level comparisons from crossing events;
- preserve indicator parameters, timeframe, direction, entries, exits, sizing and risk exactly;
- do not infer defaults such as RSI 14, a timeframe, a stop, position size, or a close rule;
- every evidence quote must be copied verbatim from the supplied lane and should be the shortest span supporting the fact;
- ready requires resolvedIntent and contract; other dispositions require contract=null;
- needs_clarification requires one or more clarificationQuestions;
- unsupported requires one or more unsupportedCapabilities;
- not_strategy has resolvedIntent=null and empty question/capability arrays;
- contract conditions use canonical strings, for example rsi("close",14,0) < 30 or crossAbove(ema("close",20,0),ema("close",20,1),ema("close",50,0),ema("close",50,1));
- every decision field is present. Unknown/not-applicable values are null. A close decision uses null for side, sizeKind, sizeValue, stopLossPercent and takeProfitRiskReward. closeFraction is the share a partial exit closes, in (0,1], and null for a whole-position exit or an open decision.

Return only one JSON object with exactly:
{"disposition":"ready|needs_clarification|unsupported|not_strategy","confidence":"high|medium|low","evidence":[{"quote":"exact source substring","supports":["fact"]}],"resolvedIntent":"string or null","contract":{"schemaVersion":"1.0","timeframe":"1m|15m|1h|4h|1d|1w","rules":[{"when":["condition"],"decision":{"type":"open|close","side":"long|short|null","sizeKind":"riskPercent|fixedNotional|null","sizeValue":null,"stopLossPercent":null,"takeProfitRiskReward":null,"closeFraction":null}}],"unsupportedCapabilities":[]},"clarificationQuestions":[],"unsupportedCapabilities":[],"rationale":"short explanation","assumptions":[]}
`.trim();

export interface DeepSeekSuggestionProviderOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  client?: OpenAI;
  maxOutputAttempts?: number;
}

export class DeepSeekInternetIntentSuggestionProvider {
  readonly model: string;
  private readonly client: OpenAI;
  private readonly maxOutputAttempts: number;

  constructor(options: DeepSeekSuggestionProviderOptions = {}) {
    const rawApiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!options.client && !rawApiKey) throw new Error("DEEPSEEK_API_KEY is required for suggestion generation.");
    this.client = options.client ?? new OpenAI({
      apiKey: normalizeDeepSeekApiKey(rawApiKey as string),
      baseURL: options.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    });
    this.model = options.model ?? process.env.DEEPSEEK_STRATEGY_MODEL ?? "deepseek-v4-pro";
    this.maxOutputAttempts = options.maxOutputAttempts ?? 2;
  }

  async suggest(candidate: InternetIntentCandidate, lane: InternetIntentSuggestionLane, input: string): Promise<InternetIntentLaneSuggestion> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < this.maxOutputAttempts; attempt += 1) {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: INSTRUCTIONS },
          { role: "user", content: `Candidate title: ${candidate.title}\nLane: ${lane}\n\nSOURCE LANE:\n${input}\n\nReturn JSON only.${attempt === 0 ? "" : ` Previous output failed validation: ${lastError?.message ?? "unknown"}`}` },
        ],
        response_format: { type: "json_object" },
        max_tokens: 4_000,
        stream: false,
      });
      const content = completion.choices[0]?.message.content;
      if (!content?.trim()) {
        lastError = new Error("DeepSeek returned an empty suggestion.");
        continue;
      }
      try {
        const artifact = parseSuggestionArtifact(candidate, content);
        const usage = completion.usage;
        return {
          lane,
          status: "completed",
          inputSha256: sha256(input),
          inputCharacters: input.length,
          model: completion.model || this.model,
          responseId: completion.id,
          usage: usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens } : null,
          artifact,
          error: null,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error("DeepSeek could not produce a valid suggestion.");
  }
}
