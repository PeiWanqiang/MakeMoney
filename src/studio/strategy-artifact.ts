import { TIMEFRAMES } from "../core/timeframes.js";
import type { StrategyModelArtifact } from "./types.js";
import { parseStrategyContract } from "../semantics/contract.js";
import type { StrategyContract } from "../semantics/contract.js";

export const STRATEGY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: { type: "string" },
    status: { type: "string", enum: ["ready", "needs_clarification", "unsupported"] },
    contract: {
      type: "object",
      additionalProperties: false,
      properties: {
        schemaVersion: { type: "string", enum: ["1.0"] },
        timeframe: { type: "string", enum: [...TIMEFRAMES] },
        rules: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              when: { type: "array", items: { type: "string" } },
              decision: {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { type: "string", enum: ["open", "close"] },
                  side: { type: ["string", "null"], enum: ["long", "short", null] },
                  sizeKind: { type: ["string", "null"], enum: ["riskPercent", "equityPercent", "fixedNotional", null] },
                  sizeValue: { type: ["number", "null"] },
                  stopLossPercent: { type: ["number", "string", "null"] },
                  takeProfitRiskReward: { type: ["number", "string", "null"] },
                  closeFraction: { type: ["number", "null"] },
                },
                required: ["type", "side", "sizeKind", "sizeValue", "stopLossPercent", "takeProfitRiskReward", "closeFraction"],
              },
            },
            required: ["when", "decision"],
          },
        },
        unsupportedCapabilities: { type: "array", items: { type: "string" } },
      },
      required: ["schemaVersion", "timeframe", "rules", "unsupportedCapabilities"],
    },
    explanation: { type: "string" },
    clarificationQuestions: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    changeSummary: { type: "string" },
  },
  required: ["status", "source", "contract", "clarificationQuestions", "explanation", "assumptions", "warnings", "changeSummary"],
} as const;

export function parseStrategyModelArtifact(text: string): StrategyModelArtifact {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The model returned malformed JSON strategy output.");
  }
  if (!value || typeof value !== "object") throw new Error("The model returned an invalid strategy artifact.");
  const artifact = value as Record<string, unknown>;
  if (artifact.status !== "ready" && artifact.status !== "needs_clarification" && artifact.status !== "unsupported") {
    throw new Error("The model response has an invalid 'status'.");
  }
  for (const field of ["source", "explanation", "changeSummary"]) {
    if (typeof artifact[field] !== "string" || (field !== "source" && artifact[field].length === 0)) {
      throw new Error(`The model response is missing '${field}'.`);
    }
  }
  let contract: StrategyContract;
  try {
    contract = parseStrategyContract(artifact.contract);
  } catch (error) {
    throw new Error(
      `The model response has an invalid strategy contract: ${error instanceof Error ? error.message : "unknown contract error"}`,
    );
  }
  if (!Array.isArray(artifact.clarificationQuestions) || !artifact.clarificationQuestions.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new Error("The model response has an invalid 'clarificationQuestions' list.");
  }
  if (artifact.status === "ready") {
    if ((artifact.source as string).length === 0) throw new Error("A ready artifact requires strategy source.");
    if (artifact.clarificationQuestions.length > 0 || contract.unsupportedCapabilities.length > 0) {
      throw new Error("A ready artifact cannot contain clarification questions or unsupported capabilities.");
    }
  }
  if (artifact.status === "needs_clarification") {
    if ((artifact.source as string).length > 0) throw new Error("A clarification artifact cannot contain strategy source.");
    if (artifact.clarificationQuestions.length === 0) throw new Error("A clarification artifact must contain questions.");
    if (contract.unsupportedCapabilities.length > 0) throw new Error("A clarification artifact cannot contain unsupported capabilities.");
  }
  if (artifact.status === "unsupported") {
    if ((artifact.source as string).length > 0) throw new Error("An unsupported artifact cannot contain strategy source.");
    if (artifact.clarificationQuestions.length > 0) throw new Error("An unsupported artifact cannot contain clarification questions.");
    if (contract.unsupportedCapabilities.length === 0) throw new Error("An unsupported artifact must identify unsupported capabilities.");
  }
  for (const field of ["assumptions", "warnings"]) {
    if (!Array.isArray(artifact[field]) || !(artifact[field] as unknown[]).every((item) => typeof item === "string")) {
      throw new Error(`The model response has an invalid '${field}' list.`);
    }
  }
  return {
    status: artifact.status,
    source: artifact.source as string,
    contract,
    clarificationQuestions: [...artifact.clarificationQuestions as string[]],
    explanation: artifact.explanation as string,
    assumptions: [...artifact.assumptions as string[]],
    warnings: [...artifact.warnings as string[]],
    changeSummary: artifact.changeSummary as string,
  };
}
