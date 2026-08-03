/**
 * Capability-gap census.
 *
 * This does not measure accuracy and produces no golden labels. It answers one
 * question: across real public strategy expressions, which capabilities does the
 * current engine fail to express, and how often?
 *
 * Two signal classes are collected, and they are NOT equally trustworthy:
 *
 * - `opaqueConditions` is deterministic. It comes from the semantic extractor
 *   itself reporting a condition it parsed but could not canonicalise, so every
 *   entry is a real vocabulary gap in extract-semantics.ts.
 * - `unsupportedCapabilities` and `clarificationQuestions` are free text written
 *   by the model. They indicate where generation struggled, not ground truth.
 *
 * Aggregation stays deterministic on purpose: exact-string counts and n-gram
 * counts, no invented capability taxonomy. Naming the families is a human step,
 * because a hardcoded taxonomy here would prejudge exactly what the census is
 * supposed to discover.
 */

export type CensusOutcome =
  | "ready"
  | "needs_clarification"
  | "unsupported"
  | "generation_error"
  | "engine_error";

export interface CensusObservation {
  schemaVersion: "1.0";
  candidateId: string;
  candidateSha256: string;
  fingerprint: string;
  generator: string;
  observedAt: string;
  sourceHost: string;
  sourceUrl: string;
  language: string;
  relevanceScore: number;
  intentChars: number;
  intentTruncated: boolean;
  outcome: CensusOutcome;
  /** Deterministic: conditions the extractor parsed but could not canonicalise. */
  opaqueConditions: string[];
  /** Model-authored free text. Weak signal. */
  unsupportedCapabilities: string[];
  /** Model-authored free text. Weak signal. */
  clarificationQuestions: string[];
  repairCount: number | null;
  durationMs: number;
  error: string | null;
}

export interface CensusFrequency {
  value: string;
  occurrences: number;
  candidates: number;
  exampleCandidateIds: string[];
}

export interface CensusReportSummary {
  observations: number;
  byOutcome: Record<CensusOutcome, number>;
  candidatesWithOpaqueConditions: number;
  candidatesWithUnsupportedCapabilities: number;
}

export interface CensusReport {
  summary: CensusReportSummary;
  opaqueConditions: CensusFrequency[];
  unsupportedCapabilities: CensusFrequency[];
  unsupportedCapabilityPhrases: CensusFrequency[];
  clarificationQuestionPhrases: CensusFrequency[];
}

/** Collapses whitespace so formatting differences do not split identical gaps. */
function normalizeExact(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * Lowercases and drops digits and quoted literals so that the same capability
 * described with different constants ("20 bars" vs "50 bars") counts as one.
 */
function normalizePhraseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/["'`]/gu, " ")
    .replace(/[0-9]+(\.[0-9]+)?%?/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const PHRASE_STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "be", "been", "being", "to", "of", "in", "on", "at", "by",
  "for", "with", "from", "as", "it", "its", "this", "that", "these", "those", "and", "or", "but",
  "if", "then", "than", "so", "not", "no", "can", "cannot", "could", "should", "would", "will",
  "does", "do", "did", "has", "have", "had", "how", "what", "when", "which", "you", "your", "i",
  "we", "our", "they", "there", "here", "please", "want", "need", "using", "use", "used",
]);

function phraseTokens(value: string): string[] {
  return normalizePhraseText(value).split(" ").filter((token) => token.length > 1 && !PHRASE_STOPWORDS.has(token));
}

function rank(
  entries: Map<string, { occurrences: number; candidates: Set<string> }>,
  minimumCandidates: number,
  limit: number,
): CensusFrequency[] {
  return [...entries.entries()]
    .filter(([, stats]) => stats.candidates.size >= minimumCandidates)
    .map(([value, stats]) => ({
      value,
      occurrences: stats.occurrences,
      candidates: stats.candidates.size,
      exampleCandidateIds: [...stats.candidates].sort().slice(0, 5),
    }))
    .sort((left, right) =>
      right.candidates - left.candidates
      || right.occurrences - left.occurrences
      || left.value.localeCompare(right.value))
    .slice(0, limit);
}

function tally(
  observations: CensusObservation[],
  select: (observation: CensusObservation) => string[],
  project: (value: string) => string[],
): Map<string, { occurrences: number; candidates: Set<string> }> {
  const entries = new Map<string, { occurrences: number; candidates: Set<string> }>();
  for (const observation of observations) {
    for (const raw of select(observation)) {
      for (const value of project(raw)) {
        if (!value) continue;
        const existing = entries.get(value) ?? { occurrences: 0, candidates: new Set<string>() };
        existing.occurrences += 1;
        existing.candidates.add(observation.candidateId);
        entries.set(value, existing);
      }
    }
  }
  return entries;
}

/** Contiguous 1..3-token windows, so multi-word capability names survive. */
function ngrams(value: string): string[] {
  const tokens = phraseTokens(value);
  const result: string[] = [];
  for (let size = 1; size <= 3; size += 1) {
    for (let index = 0; index + size <= tokens.length; index += 1) {
      result.push(tokens.slice(index, index + size).join(" "));
    }
  }
  return result;
}

export interface BuildCensusReportOptions {
  /** Ignore gaps seen in fewer than this many distinct candidates. */
  minimumCandidates?: number;
  limit?: number;
}

export function buildCensusReport(
  observations: CensusObservation[],
  options: BuildCensusReportOptions = {},
): CensusReport {
  const minimumCandidates = options.minimumCandidates ?? 2;
  const limit = options.limit ?? 60;
  const byOutcome: Record<CensusOutcome, number> = {
    ready: 0,
    needs_clarification: 0,
    unsupported: 0,
    generation_error: 0,
    engine_error: 0,
  };
  for (const observation of observations) byOutcome[observation.outcome] += 1;

  return {
    summary: {
      observations: observations.length,
      byOutcome,
      candidatesWithOpaqueConditions: observations.filter((item) => item.opaqueConditions.length > 0).length,
      candidatesWithUnsupportedCapabilities: observations.filter((item) => item.unsupportedCapabilities.length > 0).length,
    },
    // Exact strings only: an opaque condition is source code, and normalising it
    // further would merge genuinely different expressions.
    opaqueConditions: rank(
      tally(observations, (item) => item.opaqueConditions, (value) => [normalizeExact(value)]),
      1,
      limit,
    ),
    unsupportedCapabilities: rank(
      tally(observations, (item) => item.unsupportedCapabilities, (value) => [normalizeExact(value)]),
      1,
      limit,
    ),
    unsupportedCapabilityPhrases: rank(
      tally(observations, (item) => item.unsupportedCapabilities, ngrams),
      minimumCandidates,
      limit,
    ),
    clarificationQuestionPhrases: rank(
      tally(observations, (item) => item.clarificationQuestions, ngrams),
      minimumCandidates,
      limit,
    ),
  };
}
