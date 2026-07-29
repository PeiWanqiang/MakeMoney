import type { StrategyModelArtifact } from "./types.js";

export const STRATEGY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: { type: "string" },
    explanation: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    changeSummary: { type: "string" },
  },
  required: ["source", "explanation", "assumptions", "warnings", "changeSummary"],
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
  for (const field of ["source", "explanation", "changeSummary"]) {
    if (typeof artifact[field] !== "string" || artifact[field].length === 0) {
      throw new Error(`The model response is missing '${field}'.`);
    }
  }
  for (const field of ["assumptions", "warnings"]) {
    if (!Array.isArray(artifact[field]) || !(artifact[field] as unknown[]).every((item) => typeof item === "string")) {
      throw new Error(`The model response has an invalid '${field}' list.`);
    }
  }
  return artifact as unknown as StrategyModelArtifact;
}
