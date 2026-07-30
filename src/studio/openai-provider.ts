import { createHash } from "node:crypto";

import OpenAI from "openai";

import { buildStrategyProviderInput, STRATEGY_GENERATOR_INSTRUCTIONS } from "./prompt.js";
import { parseStrategyModelArtifact, STRATEGY_OUTPUT_SCHEMA } from "./strategy-artifact.js";
import type {
  StrategyProgramProvider,
  StrategyProviderRequest,
  StrategyProviderResponse,
} from "./types.js";

export interface OpenAIStrategyProviderOptions {
  apiKey?: string;
  model?: string;
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  client?: OpenAI;
}

export class OpenAIStrategyProgramProvider implements StrategyProgramProvider {
  readonly model: string;
  private readonly client: OpenAI;
  private readonly reasoningEffort: NonNullable<OpenAIStrategyProviderOptions["reasoningEffort"]>;

  constructor(options: OpenAIStrategyProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!options.client && !apiKey) {
      throw new Error("OPENAI_API_KEY is required for the OpenAI strategy provider.");
    }
    this.client = options.client ?? new OpenAI({ apiKey });
    this.model = options.model ?? process.env.STRATEGY_MODEL ?? "gpt-5.6-terra";
    this.reasoningEffort = options.reasoningEffort ?? "medium";
  }

  async generate(request: StrategyProviderRequest): Promise<StrategyProviderResponse> {
    const safetyIdentifier = `strategy_${createHash("sha256").update(request.sessionId).digest("hex").slice(0, 32)}`;
    const response = await this.client.responses.create({
      model: this.model,
      instructions: STRATEGY_GENERATOR_INSTRUCTIONS,
      input: buildStrategyProviderInput(request),
      reasoning: { effort: this.reasoningEffort },
      safety_identifier: safetyIdentifier,
      store: false,
      text: {
        verbosity: "medium",
        format: {
          type: "json_schema",
          name: "strategy_program_artifact",
          strict: true,
          schema: STRATEGY_OUTPUT_SCHEMA,
        },
      },
    });
    if (!response.output_text) throw new Error("The OpenAI response did not contain strategy output text.");
    return {
      artifact: parseStrategyModelArtifact(response.output_text),
      provider: "openai",
      model: this.model,
      responseId: response.id,
      ...(response.usage === undefined ? {} : {
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          totalTokens: response.usage.total_tokens,
          cachedInputTokens: response.usage.input_tokens_details.cached_tokens,
          uncachedInputTokens: Math.max(0, response.usage.input_tokens - response.usage.input_tokens_details.cached_tokens),
          reasoningTokens: response.usage.output_tokens_details.reasoning_tokens,
        },
      }),
    };
  }
}
