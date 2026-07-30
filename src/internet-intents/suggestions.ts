import { compareStrategyContracts, normalizeContract, type SemanticDiagnostic, type StrategyContract } from "../semantics/contract.js";
import { sha256 } from "./pipeline.js";
import { validateReview, type InternetIntentConfidence, type InternetIntentDisposition, type InternetIntentEvidenceSpan, type InternetIntentReview } from "./review.js";
import type { InternetIntentCandidate } from "./types.js";

export type InternetIntentSuggestionLane = "prose" | "code";

export interface InternetIntentSegments {
  prose: string;
  code: string;
  proseLineCount: number;
  codeLineCount: number;
}

export interface InternetIntentSuggestionArtifact {
  disposition: InternetIntentDisposition;
  confidence: InternetIntentConfidence;
  evidence: InternetIntentEvidenceSpan[];
  resolvedIntent: string | null;
  contract: StrategyContract | null;
  clarificationQuestions: string[];
  unsupportedCapabilities: string[];
  rationale: string;
  assumptions: string[];
}

export interface InternetIntentLaneSuggestion {
  lane: InternetIntentSuggestionLane;
  status: "completed" | "unavailable" | "error";
  inputSha256: string;
  inputCharacters: number;
  model: string | null;
  responseId: string | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  artifact: InternetIntentSuggestionArtifact | null;
  error: string | null;
}

export interface InternetIntentSuggestionReport {
  schemaVersion: "1.0";
  candidateId: string;
  candidateSha256: string;
  generatedAt: string;
  generator: string;
  lanes: InternetIntentLaneSuggestion[];
  comparison: {
    status: "agree" | "conflict" | "insufficient";
    diagnostics: SemanticDiagnostic[];
  };
  warning: "AI suggestions are reviewer aids only and must never be imported as submitted annotations.";
}

const CODE_PATTERNS = [
  /^\s*(?:\/\/|\/\*|\*\/|#\s*(?:include|define)|import\s|from\s+\S+\s+import\s|def\s|class\s|function\s)/,
  /^\s*(?:if|else|elif|for|while|switch|return|try|catch)\b.*(?:[:{]|\))/,
  /^\s*(?:strategy|indicator|library)\s*\(/i,
  /\b(?:strategy\.|ta\.|math\.|request\.security|input\.|plot\(|defineStrategy\(|context\.)/,
  /^\s*[A-Za-z_$][\w$]*(?:\[[^\]]+])?\s*(?::=|=|\+=|-=|\*=|\/=)/,
  /(?:=>|\{\s*$|\}\s*;?$|;\s*$)/,
];

export function looksLikeCodeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return CODE_PATTERNS.some((pattern) => pattern.test(line));
}

export function segmentIntentText(rawText: string): InternetIntentSegments {
  const prose: string[] = [];
  const code: string[] = [];
  for (const line of rawText.split("\n")) {
    if (!line.trim()) continue;
    (looksLikeCodeLine(line) ? code : prose).push(line);
  }
  return {
    prose: prose.join("\n"),
    code: code.join("\n"),
    proseLineCount: prose.length,
    codeLineCount: code.length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new Error(`${field} must be an array of non-empty strings.`);
  }
  return value;
}

function locateEvidence(candidate: InternetIntentCandidate, value: unknown): InternetIntentEvidenceSpan[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("evidence must contain at least one item.");
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.quote !== "string" || item.quote.length === 0) throw new Error(`evidence[${index}].quote is required.`);
    const start = candidate.rawText.indexOf(item.quote);
    if (start < 0) throw new Error(`evidence[${index}].quote is not an exact substring of the source.`);
    const supports = stringArray(item.supports, `evidence[${index}].supports`);
    if (supports.length === 0) throw new Error(`evidence[${index}].supports cannot be empty.`);
    return { start, end: start + item.quote.length, quote: item.quote, supports };
  });
}

export function parseSuggestionArtifact(candidate: InternetIntentCandidate, input: string): InternetIntentSuggestionArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("Suggestion provider returned malformed JSON.");
  }
  if (!isRecord(parsed)) throw new Error("Suggestion must be a JSON object.");
  const disposition = parsed.disposition;
  const confidence = parsed.confidence;
  if (!["ready", "needs_clarification", "unsupported", "not_strategy"].includes(String(disposition))) throw new Error("disposition is invalid.");
  if (!["high", "medium", "low"].includes(String(confidence))) throw new Error("confidence is invalid.");
  if (parsed.resolvedIntent !== null && typeof parsed.resolvedIntent !== "string") throw new Error("resolvedIntent must be a string or null.");
  if (typeof parsed.rationale !== "string" || !parsed.rationale.trim()) throw new Error("rationale is required.");
  const artifact: InternetIntentSuggestionArtifact = {
    disposition: disposition as InternetIntentDisposition,
    confidence: confidence as InternetIntentConfidence,
    evidence: locateEvidence(candidate, parsed.evidence),
    resolvedIntent: parsed.resolvedIntent,
    contract: parsed.contract as StrategyContract | null,
    clarificationQuestions: stringArray(parsed.clarificationQuestions, "clarificationQuestions"),
    unsupportedCapabilities: stringArray(parsed.unsupportedCapabilities, "unsupportedCapabilities"),
    rationale: parsed.rationale,
    assumptions: stringArray(parsed.assumptions, "assumptions"),
  };
  const review: InternetIntentReview = {
    schemaVersion: "1.0",
    reviewId: `suggestion-${candidate.id}`,
    kind: "review",
    candidateId: candidate.id,
    candidateSha256: candidate.rawSha256,
    reviewerId: "ai-suggestion-not-a-reviewer",
    status: "submitted",
    disposition: artifact.disposition,
    confidence: artifact.confidence,
    evidence: artifact.evidence,
    resolvedIntent: artifact.resolvedIntent,
    contract: artifact.contract,
    clarificationQuestions: artifact.clarificationQuestions,
    unsupportedCapabilities: artifact.unsupportedCapabilities,
    notes: [],
    basedOnReviewIds: [],
    submittedAt: new Date(0).toISOString(),
  };
  const diagnostics = validateReview(candidate, review);
  if (diagnostics.length > 0) throw new Error(`Suggestion failed review-shape validation: ${diagnostics.join(" ")}`);
  return { ...artifact, contract: artifact.contract ? normalizeContract(artifact.contract) : null };
}

export function compareLaneSuggestions(lanes: InternetIntentLaneSuggestion[]): InternetIntentSuggestionReport["comparison"] {
  const completed = lanes.filter((lane): lane is InternetIntentLaneSuggestion & { artifact: InternetIntentSuggestionArtifact } => lane.status === "completed" && lane.artifact !== null);
  if (completed.length < 2) return { status: "insufficient", diagnostics: [] };
  const [first, second] = completed;
  if (!first || !second) return { status: "insufficient", diagnostics: [] };
  const diagnostics: SemanticDiagnostic[] = [];
  if (first.artifact.disposition !== second.artifact.disposition) diagnostics.push({
    code: "LANE_DISPOSITION_CONFLICT",
    message: "Prose and code lanes recommend different dispositions.",
    expected: first.artifact.disposition,
    actual: second.artifact.disposition,
  });
  if (first.artifact.contract && second.artifact.contract) diagnostics.push(...compareStrategyContracts(first.artifact.contract, second.artifact.contract));
  if (first.artifact.disposition === "needs_clarification" && second.artifact.disposition === "needs_clarification" &&
      JSON.stringify([...first.artifact.clarificationQuestions].sort()) !== JSON.stringify([...second.artifact.clarificationQuestions].sort())) {
    diagnostics.push({ code: "LANE_CLARIFICATION_CONFLICT", message: "Prose and code lanes identify different missing information." });
  }
  return { status: diagnostics.length === 0 ? "agree" : "conflict", diagnostics };
}

export function unavailableLane(lane: InternetIntentSuggestionLane, input: string, error: string | null = null): InternetIntentLaneSuggestion {
  return {
    lane,
    status: error ? "error" : "unavailable",
    inputSha256: sha256(input),
    inputCharacters: input.length,
    model: null,
    responseId: null,
    usage: null,
    artifact: null,
    error,
  };
}
