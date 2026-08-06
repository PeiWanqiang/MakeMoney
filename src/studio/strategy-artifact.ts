import { isTimeframe, TIMEFRAMES } from "../core/timeframes.js";
import type { StrategyModelArtifact } from "./types.js";
import { normalizeCloseFraction } from "../semantics/contract.js";
import type { ContractDecision, ContractRule, ContractTimeframe, StrategyContract } from "../semantics/contract.js";

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
                  sizeKind: { type: ["string", "null"], enum: ["riskPercent", "fixedNotional", null] },
                  sizeValue: { type: ["number", "null"] },
                  stopLossPercent: { type: ["number", "null"] },
                  takeProfitRiskReward: { type: ["number", "null"] },
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
  const contract = artifact.contract as Record<string, unknown> | undefined;
  if (
    !contract || contract.schemaVersion !== "1.0" ||
    !isTimeframe(contract.timeframe) ||
    !Array.isArray(contract.rules) || !Array.isArray(contract.unsupportedCapabilities)
  ) {
    throw new Error("The model response has an invalid strategy contract.");
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
  if (!(contract.unsupportedCapabilities as unknown[]).every((item) => typeof item === "string")) {
    throw new Error("The model response has invalid unsupported capabilities.");
  }
  const parsedRules: ContractRule[] = (contract.rules as unknown[]).map((rule, index) => {
    if (!rule || typeof rule !== "object") throw new Error(`Contract rule ${index + 1} is invalid.`);
    const candidate = rule as Record<string, unknown>;
    if (!Array.isArray(candidate.when) || !candidate.when.every((condition) => typeof condition === "string" && condition.trim().length > 0)) {
      throw new Error(`Contract rule ${index + 1} has invalid conditions.`);
    }
    if (!candidate.decision || typeof candidate.decision !== "object") {
      throw new Error(`Contract rule ${index + 1} has an invalid decision.`);
    }
    const decision = candidate.decision as Record<string, unknown>;
    const type = decision.type;
    const side = decision.side;
    const sizeKind = decision.sizeKind;
    const numberOrNull = (field: string): number | null => {
      const fieldValue = decision[field];
      if (fieldValue === null) return null;
      if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
        throw new Error(`Contract rule ${index + 1} has invalid '${field}'.`);
      }
      return fieldValue;
    };
    if (type !== "open" && type !== "close") throw new Error(`Contract rule ${index + 1} has an invalid decision type.`);
    if (side !== null && side !== "long" && side !== "short") throw new Error(`Contract rule ${index + 1} has an invalid side.`);
    if (sizeKind !== null && sizeKind !== "riskPercent" && sizeKind !== "fixedNotional") {
      throw new Error(`Contract rule ${index + 1} has an invalid size kind.`);
    }
    const closeFraction = normalizeCloseFraction(numberOrNull("closeFraction"));
    const parsedDecision: ContractDecision = {
      type,
      side,
      sizeKind,
      sizeValue: numberOrNull("sizeValue"),
      stopLossPercent: numberOrNull("stopLossPercent"),
      takeProfitRiskReward: numberOrNull("takeProfitRiskReward"),
      closeFraction,
    };
    if (type === "open" && (side === null || sizeKind === null || parsedDecision.sizeValue === null || parsedDecision.stopLossPercent === null)) {
      throw new Error(`Contract rule ${index + 1} has an incomplete open decision.`);
    }
    if (type === "open" && closeFraction !== null) {
      throw new Error(`Contract rule ${index + 1} sizes an open decision with a close fraction.`);
    }
    // closeFraction is the one close field that carries meaning, so it is
    // excluded from the all-null check rather than being rejected with the rest.
    if (type === "close" && [side, sizeKind, parsedDecision.sizeValue, parsedDecision.stopLossPercent, parsedDecision.takeProfitRiskReward].some((item) => item !== null)) {
      throw new Error(`Contract rule ${index + 1} has a non-null close decision field.`);
    }
    if (closeFraction !== null && (closeFraction <= 0 || closeFraction > 1)) {
      throw new Error(`Contract rule ${index + 1} has a close fraction outside (0, 1].`);
    }
    return { when: [...candidate.when] as string[], decision: parsedDecision };
  });
  const parsedContract: StrategyContract = {
    schemaVersion: "1.0",
    timeframe: contract.timeframe as ContractTimeframe,
    rules: parsedRules,
    unsupportedCapabilities: [...contract.unsupportedCapabilities] as string[],
  };
  return {
    status: artifact.status,
    source: artifact.source as string,
    contract: parsedContract,
    clarificationQuestions: [...artifact.clarificationQuestions as string[]],
    explanation: artifact.explanation as string,
    assumptions: [...artifact.assumptions as string[]],
    warnings: [...artifact.warnings as string[]],
    changeSummary: artifact.changeSummary as string,
  };
}
