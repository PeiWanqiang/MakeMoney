import { TIMEFRAMES as SUPPORTED_TIMEFRAMES } from "../core/timeframes.js";
import { normalizeContract, type StrategyContract } from "../semantics/contract.js";
import { sha256 } from "./pipeline.js";
import type { InternetIntentCandidate, InternetIntentLanguage, InternetIntentSource } from "./types.js";

export type InternetIntentDisposition = "ready" | "needs_clarification" | "unsupported" | "not_strategy";
export type InternetIntentConfidence = "high" | "medium" | "low";
export type InternetIntentSplit = "development" | "validation" | "blind";

export interface InternetIntentEvidenceSpan {
  start: number;
  end: number;
  quote: string;
  supports: string[];
}

export interface InternetIntentReview {
  schemaVersion: "1.0";
  reviewId: string;
  kind: "review" | "adjudication";
  candidateId: string;
  candidateSha256: string;
  reviewerId: string;
  status: "draft" | "submitted";
  disposition: InternetIntentDisposition | null;
  confidence: InternetIntentConfidence | null;
  evidence: InternetIntentEvidenceSpan[];
  resolvedIntent: string | null;
  contract: StrategyContract | null;
  clarificationQuestions: string[];
  unsupportedCapabilities: string[];
  notes: string[];
  basedOnReviewIds: string[];
  submittedAt: string | null;
}

export interface InternetIntentAnnotation {
  schemaVersion: "1.0";
  annotationId: string;
  candidateId: string;
  candidateSha256: string;
  reviews: InternetIntentReview[];
  adjudication: InternetIntentReview | null;
  createdAt: string;
  updatedAt: string;
}

export interface InternetIntentReviewQueueItem {
  candidate: InternetIntentCandidate;
  review: InternetIntentReview;
}

export interface InternetIntentBlindReviewQueueItem {
  candidate: Pick<InternetIntentCandidate, "id" | "title" | "rawText" | "rawSha256" | "language">;
  review: InternetIntentReview;
}

export interface InternetIntentAdjudicationQueueItem {
  candidate: InternetIntentBlindReviewQueueItem["candidate"];
  independentReviews: Array<Omit<InternetIntentReview, "reviewerId"> & { reviewerAlias: string }>;
  disputed: boolean;
  adjudication: InternetIntentReview;
}

export interface InternetIntentAgreementReport {
  paired: number;
  dispositionAgreements: number;
  dispositionAgreementRate: number;
  exactDecisionAgreements: number;
  exactDecisionAgreementRate: number;
  cohensKappa: number | null;
}

export interface InternetIntentGoldenRecord {
  schemaVersion: "1.0";
  id: string;
  candidateId: string;
  split: InternetIntentSplit;
  source: InternetIntentSource;
  sourceUrl: string;
  sourceRecordId: string;
  language: InternetIntentLanguage;
  license: InternetIntentCandidate["license"];
  authorGroupHash: string;
  rawIntent: string;
  rawSha256: string;
  expectedFirstAction: Exclude<InternetIntentDisposition, "not_strategy">;
  confidence: InternetIntentConfidence;
  evidence: InternetIntentEvidenceSpan[];
  resolvedIntent: string | null;
  contract: StrategyContract | null;
  clarificationQuestions: string[];
  unsupportedCapabilities: string[];
  annotationId: string;
  resolutionReviewId: string;
}

export interface InternetIntentGoldenManifest {
  schemaVersion: "1.0";
  generatedAt: string;
  splitSalt: string;
  minimumIndependentReviews: number;
  adjudicationRequired: boolean;
  counts: {
    annotations: number;
    exported: number;
    excludedNotStrategy: number;
    byDisposition: Record<string, number>;
    bySplit: Record<string, number>;
  };
  corpusSha256: string;
}

export interface ReviewQueueOptions {
  reviewerId: string;
  limit?: number;
  source?: InternetIntentSource;
  language?: InternetIntentLanguage;
  relevance?: InternetIntentCandidate["relevance"]["status"];
}

export interface GoldenCorpusOptions {
  minimumIndependentReviews?: number;
  requireAdjudication?: boolean;
  splitSalt?: string;
  now?: string;
}

const DISPOSITIONS = new Set<InternetIntentDisposition>(["ready", "needs_clarification", "unsupported", "not_strategy"]);
const CONFIDENCES = new Set<InternetIntentConfidence>(["high", "medium", "low"]);
const TIMEFRAMES = new Set<string>(SUPPORTED_TIMEFRAMES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

export function parseReview(value: unknown): InternetIntentReview {
  if (!isRecord(value)) throw new Error("Review JSON must be an object.");
  const requiredStrings = ["schemaVersion", "reviewId", "kind", "candidateId", "candidateSha256", "reviewerId", "status"];
  for (const field of requiredStrings) {
    if (typeof value[field] !== "string") throw new Error(`Review field ${field} must be a string.`);
  }
  for (const field of ["evidence", "clarificationQuestions", "unsupportedCapabilities", "notes", "basedOnReviewIds"]) {
    if (!Array.isArray(value[field])) throw new Error(`Review field ${field} must be an array.`);
  }
  if (value.resolvedIntent !== null && typeof value.resolvedIntent !== "string") throw new Error("resolvedIntent must be a string or null.");
  if (value.submittedAt !== null && typeof value.submittedAt !== "string") throw new Error("submittedAt must be a string or null.");
  const evidenceValues = value.evidence as unknown[];
  for (const [index, evidence] of evidenceValues.entries()) {
    if (!isRecord(evidence)) throw new Error(`evidence[${index}] must be an object.`);
    if (typeof evidence.start !== "number" || typeof evidence.end !== "number" || typeof evidence.quote !== "string" || !Array.isArray(evidence.supports)) {
      throw new Error(`evidence[${index}] has an invalid shape.`);
    }
  }
  return value as unknown as InternetIntentReview;
}

function contractDiagnostics(value: unknown): string[] {
  if (!isRecord(value)) return ["contract must be an object."];
  const diagnostics: string[] = [];
  if (value.schemaVersion !== "1.0") diagnostics.push("contract.schemaVersion must be 1.0.");
  if (typeof value.timeframe !== "string" || !TIMEFRAMES.has(value.timeframe)) {
    diagnostics.push(`contract.timeframe must be one of ${SUPPORTED_TIMEFRAMES.join(", ")}.`);
  }
  if (!Array.isArray(value.unsupportedCapabilities) || !value.unsupportedCapabilities.every((item) => typeof item === "string")) {
    diagnostics.push("contract.unsupportedCapabilities must be a string array.");
  }
  if (!Array.isArray(value.rules) || value.rules.length === 0) {
    diagnostics.push("contract.rules must contain at least one rule.");
    return diagnostics;
  }
  for (const [index, rule] of value.rules.entries()) {
    if (!isRecord(rule)) {
      diagnostics.push(`contract.rules[${index}] must be an object.`);
      continue;
    }
    if (!isStringArray(rule.when)) diagnostics.push(`contract.rules[${index}].when must contain conditions.`);
    if (!isRecord(rule.decision)) {
      diagnostics.push(`contract.rules[${index}].decision must be an object.`);
      continue;
    }
    const decision = rule.decision;
    if (decision.type !== "open" && decision.type !== "close") diagnostics.push(`contract.rules[${index}].decision.type is invalid.`);
    if (decision.side !== null && decision.side !== "long" && decision.side !== "short") diagnostics.push(`contract.rules[${index}].decision.side is invalid.`);
    if (decision.sizeKind !== null && decision.sizeKind !== "riskPercent" && decision.sizeKind !== "fixedNotional") {
      diagnostics.push(`contract.rules[${index}].decision.sizeKind is invalid.`);
    }
    for (const field of ["sizeValue", "stopLossPercent", "takeProfitRiskReward"] as const) {
      const item = decision[field];
      if (item !== null && (typeof item !== "number" || !Number.isFinite(item))) {
        diagnostics.push(`contract.rules[${index}].decision.${field} must be a finite number or null.`);
      }
    }
  }
  return diagnostics;
}

function decisionDiagnostics(candidate: InternetIntentCandidate, review: InternetIntentReview): string[] {
  const diagnostics: string[] = [];
  if (!review.disposition || !DISPOSITIONS.has(review.disposition)) diagnostics.push("disposition must be selected.");
  if (!review.confidence || !CONFIDENCES.has(review.confidence)) diagnostics.push("confidence must be selected.");
  if (review.evidence.length === 0) diagnostics.push("at least one evidence span is required.");
  for (const [index, evidence] of review.evidence.entries()) {
    if (!Number.isInteger(evidence.start) || !Number.isInteger(evidence.end) || evidence.start < 0 || evidence.end <= evidence.start || evidence.end > candidate.rawText.length) {
      diagnostics.push(`evidence[${index}] has an invalid character range.`);
      continue;
    }
    if (candidate.rawText.slice(evidence.start, evidence.end) !== evidence.quote) {
      diagnostics.push(`evidence[${index}].quote does not exactly match candidate rawText.`);
    }
    if (!isStringArray(evidence.supports)) diagnostics.push(`evidence[${index}].supports must identify supported facts.`);
  }
  if (review.disposition === "ready") {
    if (!review.resolvedIntent?.trim()) diagnostics.push("ready review requires resolvedIntent.");
    diagnostics.push(...contractDiagnostics(review.contract));
    if (review.contract && Array.isArray(review.contract.unsupportedCapabilities) && review.contract.unsupportedCapabilities.length > 0) {
      diagnostics.push("ready contract cannot contain unsupported capabilities.");
    }
    if (review.clarificationQuestions.length > 0) diagnostics.push("ready review cannot contain clarification questions.");
    if (review.unsupportedCapabilities.length > 0) diagnostics.push("ready review cannot contain unsupported capabilities.");
  } else if (review.disposition === "needs_clarification") {
    if (review.contract !== null) diagnostics.push("needs_clarification review cannot contain a contract.");
    if (!isStringArray(review.clarificationQuestions)) diagnostics.push("needs_clarification review requires questions.");
    if (review.unsupportedCapabilities.length > 0) diagnostics.push("needs_clarification review cannot contain unsupported capabilities.");
  } else if (review.disposition === "unsupported") {
    if (review.contract !== null) diagnostics.push("unsupported review cannot contain a contract.");
    if (!isStringArray(review.unsupportedCapabilities)) diagnostics.push("unsupported review requires unsupported capabilities.");
    if (review.clarificationQuestions.length > 0) diagnostics.push("unsupported review cannot contain clarification questions.");
  } else if (review.disposition === "not_strategy") {
    if (review.contract !== null) diagnostics.push("not_strategy review cannot contain a contract.");
    if (review.resolvedIntent?.trim()) diagnostics.push("not_strategy review cannot contain resolvedIntent.");
    if (review.clarificationQuestions.length > 0 || review.unsupportedCapabilities.length > 0) {
      diagnostics.push("not_strategy review cannot contain questions or unsupported capabilities.");
    }
  }
  return diagnostics;
}

export function createReviewDraft(candidate: InternetIntentCandidate, reviewerId: string, kind: InternetIntentReview["kind"] = "review"): InternetIntentReview {
  const reviewerHash = sha256(reviewerId.trim()).slice(0, 12);
  return {
    schemaVersion: "1.0",
    reviewId: `${kind}-${candidate.id}-${reviewerHash}`,
    kind,
    candidateId: candidate.id,
    candidateSha256: candidate.rawSha256,
    reviewerId: reviewerId.trim(),
    status: "draft",
    disposition: null,
    confidence: null,
    evidence: [],
    resolvedIntent: null,
    contract: null,
    clarificationQuestions: [],
    unsupportedCapabilities: [],
    notes: [],
    basedOnReviewIds: [],
    submittedAt: null,
  };
}

export function blindReviewQueueItem(item: InternetIntentReviewQueueItem): InternetIntentBlindReviewQueueItem {
  const { candidate, review } = item;
  return {
    candidate: {
      id: candidate.id,
      title: candidate.title,
      rawText: candidate.rawText,
      rawSha256: candidate.rawSha256,
      language: candidate.language,
    },
    review,
  };
}

export function validateReview(candidate: InternetIntentCandidate, review: InternetIntentReview): string[] {
  const diagnostics: string[] = [];
  if (review.schemaVersion !== "1.0") diagnostics.push("review.schemaVersion must be 1.0.");
  if (!review.reviewId?.trim()) diagnostics.push("reviewId is required.");
  if (!review.reviewerId?.trim()) diagnostics.push("reviewerId is required.");
  if (review.kind !== "review" && review.kind !== "adjudication") diagnostics.push("review.kind must be review or adjudication.");
  if (review.candidateId !== candidate.id) diagnostics.push("candidateId does not match the candidate.");
  if (review.candidateSha256 !== candidate.rawSha256) diagnostics.push("candidateSha256 does not match current candidate text.");
  if (review.status !== "submitted") diagnostics.push("review.status must be submitted.");
  if (!review.submittedAt || !Number.isFinite(Date.parse(review.submittedAt))) diagnostics.push("submittedAt must be an ISO date.");
  if (!Array.isArray(review.evidence)) diagnostics.push("evidence must be an array.");
  else diagnostics.push(...decisionDiagnostics(candidate, review));
  if (review.notes.some((item) => typeof item !== "string" || item.trim().length === 0)) diagnostics.push("notes must contain non-empty strings.");
  if (review.basedOnReviewIds.some((item) => typeof item !== "string" || item.trim().length === 0)) diagnostics.push("basedOnReviewIds must contain non-empty strings.");
  if (review.kind === "review" && review.basedOnReviewIds.length > 0) diagnostics.push("independent review cannot depend on other reviews.");
  if (review.kind === "adjudication" && review.basedOnReviewIds.length === 0) diagnostics.push("adjudication must reference independent reviews.");
  return diagnostics;
}

export function mergeReview(
  candidate: InternetIntentCandidate,
  existing: InternetIntentAnnotation | undefined,
  review: InternetIntentReview,
  now = new Date().toISOString(),
): InternetIntentAnnotation {
  const diagnostics = validateReview(candidate, review);
  if (diagnostics.length > 0) throw new Error(`Review validation failed:\n- ${diagnostics.join("\n- ")}`);
  const annotation: InternetIntentAnnotation = existing ?? {
    schemaVersion: "1.0",
    annotationId: `annotation-${candidate.id}`,
    candidateId: candidate.id,
    candidateSha256: candidate.rawSha256,
    reviews: [],
    adjudication: null,
    createdAt: now,
    updatedAt: now,
  };
  if (annotation.candidateSha256 !== candidate.rawSha256) throw new Error("Stored annotation refers to an older candidate revision.");
  if (review.kind === "adjudication") {
    const independentIds = new Set(annotation.reviews.map((item) => item.reviewId));
    const missing = review.basedOnReviewIds.filter((id) => !independentIds.has(id));
    if (missing.length > 0) throw new Error(`Adjudication references unknown reviews: ${missing.join(", ")}`);
    return { ...annotation, adjudication: review, updatedAt: now };
  }
  const reviews = annotation.reviews.filter((item) => item.reviewerId !== review.reviewerId);
  reviews.push(review);
  reviews.sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
  return { ...annotation, reviews, adjudication: null, updatedAt: now };
}

export function reviewDecisionSignature(review: InternetIntentReview): string {
  return JSON.stringify({
    disposition: review.disposition,
    resolvedIntent: review.resolvedIntent?.trim() ?? null,
    contract: review.contract ? normalizeContract(review.contract) : null,
    clarificationQuestions: [...review.clarificationQuestions].sort(),
    unsupportedCapabilities: [...review.unsupportedCapabilities].sort(),
  });
}

export function calculateReviewAgreement(
  annotations: InternetIntentAnnotation[],
  reviewerA: string,
  reviewerB: string,
): InternetIntentAgreementReport {
  const pairs = annotations.flatMap((annotation) => {
    const left = annotation.reviews.find((review) => review.reviewerId === reviewerA);
    const right = annotation.reviews.find((review) => review.reviewerId === reviewerB);
    return left && right ? [{ left, right }] : [];
  });
  const dispositions = ["ready", "needs_clarification", "unsupported", "not_strategy"] as const;
  const dispositionAgreements = pairs.filter(({ left, right }) => left.disposition === right.disposition).length;
  const exactDecisionAgreements = pairs.filter(({ left, right }) => reviewDecisionSignature(left) === reviewDecisionSignature(right)).length;
  if (pairs.length === 0) return {
    paired: 0,
    dispositionAgreements: 0,
    dispositionAgreementRate: 0,
    exactDecisionAgreements: 0,
    exactDecisionAgreementRate: 0,
    cohensKappa: null,
  };
  const observed = dispositionAgreements / pairs.length;
  const expected = dispositions.reduce((sum, disposition) => {
    const left = pairs.filter((pair) => pair.left.disposition === disposition).length / pairs.length;
    const right = pairs.filter((pair) => pair.right.disposition === disposition).length / pairs.length;
    return sum + left * right;
  }, 0);
  const kappa = expected === 1 ? (observed === 1 ? 1 : 0) : (observed - expected) / (1 - expected);
  return {
    paired: pairs.length,
    dispositionAgreements,
    dispositionAgreementRate: observed,
    exactDecisionAgreements,
    exactDecisionAgreementRate: exactDecisionAgreements / pairs.length,
    cohensKappa: Math.round(kappa * 10_000) / 10_000,
  };
}

export function selectAdjudicationQueue(
  candidates: InternetIntentCandidate[],
  annotations: InternetIntentAnnotation[],
  adjudicatorId: string,
): InternetIntentAdjudicationQueueItem[] {
  const byCandidate = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return annotations
    .filter((annotation) => annotation.reviews.length >= 2 && !annotation.adjudication)
    .map((annotation) => {
      const candidate = byCandidate.get(annotation.candidateId);
      if (!candidate) throw new Error(`Candidate ${annotation.candidateId} is missing.`);
      const adjudication = createReviewDraft(candidate, adjudicatorId, "adjudication");
      adjudication.basedOnReviewIds = annotation.reviews.map((review) => review.reviewId).sort();
      return {
        candidate: blindReviewQueueItem({ candidate, review: adjudication }).candidate,
        independentReviews: annotation.reviews.map(({ reviewerId: _reviewerId, ...review }, index) => ({ ...review, reviewerAlias: `reviewer-${index + 1}` })),
        disputed: new Set(annotation.reviews.map(reviewDecisionSignature)).size > 1,
        adjudication,
      };
    })
    .sort((left, right) => Number(right.disputed) - Number(left.disputed) || left.candidate.id.localeCompare(right.candidate.id));
}

export function selectReviewQueue(
  candidates: InternetIntentCandidate[],
  annotations: InternetIntentAnnotation[],
  options: ReviewQueueOptions,
): InternetIntentReviewQueueItem[] {
  if (!options.reviewerId.trim()) throw new Error("reviewerId is required.");
  const reviewed = new Set(
    annotations.flatMap((annotation) => annotation.reviews
      .filter((review) => review.reviewerId === options.reviewerId)
      .map(() => annotation.candidateId)),
  );
  const groups = new Map<string, InternetIntentCandidate[]>();
  for (const candidate of candidates) {
    if (reviewed.has(candidate.id)) continue;
    if (options.source && candidate.source !== options.source) continue;
    if (options.language && candidate.language !== options.language) continue;
    if (options.relevance && candidate.relevance.status !== options.relevance) continue;
    const key = `${candidate.source}:${candidate.language}:${candidate.relevance.status}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => right.relevance.score - left.relevance.score || left.id.localeCompare(right.id));
  }
  const orderedGroups = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  const selected: InternetIntentCandidate[] = [];
  const limit = options.limit ?? 25;
  for (let offset = 0; selected.length < limit; offset += 1) {
    let added = false;
    for (const [, group] of orderedGroups) {
      const candidate = group[offset];
      if (!candidate) continue;
      selected.push(candidate);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return selected.map((candidate) => ({ candidate, review: createReviewDraft(candidate, options.reviewerId) }));
}

export function splitGroupHash(candidate: InternetIntentCandidate): string {
  const group = candidate.repository
    ? `repository:${candidate.source}:${candidate.repository.fullName.toLowerCase()}`
    : `author:${candidate.source}:${candidate.author.idHash}`;
  return sha256(group);
}

export function splitForCandidate(candidate: InternetIntentCandidate, salt = "internet-intents-v1"): InternetIntentSplit {
  const sample = Number.parseInt(sha256(`${salt}:${splitGroupHash(candidate)}`).slice(0, 8), 16) / 0x1_0000_0000;
  if (sample < 0.5) return "development";
  if (sample < 0.75) return "validation";
  return "blind";
}

function countBy<T>(values: T[], select: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = select(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function buildGoldenCorpus(
  candidates: InternetIntentCandidate[],
  annotations: InternetIntentAnnotation[],
  options: GoldenCorpusOptions = {},
): { records: InternetIntentGoldenRecord[]; manifest: InternetIntentGoldenManifest } {
  const minimumReviews = options.minimumIndependentReviews ?? 2;
  const requireAdjudication = options.requireAdjudication ?? minimumReviews >= 2;
  const splitSalt = options.splitSalt ?? "internet-intents-v1";
  if (!Number.isInteger(minimumReviews) || minimumReviews < 1) throw new Error("minimumIndependentReviews must be a positive integer.");
  if (annotations.length === 0) throw new Error("No reviewed annotations are available for export.");
  const byCandidate = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const records: InternetIntentGoldenRecord[] = [];
  let excludedNotStrategy = 0;
  for (const annotation of annotations) {
    const candidate = byCandidate.get(annotation.candidateId);
    if (!candidate) throw new Error(`Candidate ${annotation.candidateId} is missing.`);
    if (annotation.candidateSha256 !== candidate.rawSha256) throw new Error(`Annotation ${annotation.annotationId} is stale.`);
    const distinctReviewers = new Set(annotation.reviews.map((review) => review.reviewerId));
    if (distinctReviewers.size < minimumReviews) {
      throw new Error(`Annotation ${annotation.annotationId} has ${distinctReviewers.size} independent reviews; ${minimumReviews} required.`);
    }
    for (const review of annotation.reviews) {
      const diagnostics = validateReview(candidate, review);
      if (diagnostics.length > 0) throw new Error(`Stored review ${review.reviewId} is invalid: ${diagnostics.join(" ")}`);
    }
    const signatures = new Set(annotation.reviews.map(reviewDecisionSignature));
    if (signatures.size > 1 && !annotation.adjudication) throw new Error(`Annotation ${annotation.annotationId} has reviewer disagreement and needs adjudication.`);
    if (requireAdjudication && !annotation.adjudication) throw new Error(`Annotation ${annotation.annotationId} requires adjudication.`);
    const resolution = annotation.adjudication ?? annotation.reviews[0];
    if (!resolution) throw new Error(`Annotation ${annotation.annotationId} has no resolution.`);
    if (annotation.adjudication) {
      const diagnostics = validateReview(candidate, annotation.adjudication);
      if (diagnostics.length > 0) throw new Error(`Adjudication ${annotation.adjudication.reviewId} is invalid: ${diagnostics.join(" ")}`);
      const ids = new Set(annotation.reviews.map((review) => review.reviewId));
      if (annotation.adjudication.basedOnReviewIds.some((id) => !ids.has(id))) {
        throw new Error(`Adjudication ${annotation.adjudication.reviewId} references unknown reviews.`);
      }
      if (annotation.adjudication.basedOnReviewIds.length !== ids.size || [...ids].some((id) => !annotation.adjudication?.basedOnReviewIds.includes(id))) {
        throw new Error(`Adjudication ${annotation.adjudication.reviewId} must reference every independent review.`);
      }
      if (distinctReviewers.has(annotation.adjudication.reviewerId)) {
        throw new Error(`Adjudicator ${annotation.adjudication.reviewerId} must be independent from the reviewers.`);
      }
    }
    if (resolution.disposition === "not_strategy") {
      excludedNotStrategy += 1;
      continue;
    }
    if (!resolution.disposition || !resolution.confidence) throw new Error(`Annotation ${annotation.annotationId} has an incomplete resolution.`);
    records.push({
      schemaVersion: "1.0",
      id: `gold-${candidate.id}`,
      candidateId: candidate.id,
      split: splitForCandidate(candidate, splitSalt),
      source: candidate.source,
      sourceUrl: candidate.sourceUrl,
      sourceRecordId: candidate.sourceRecordId,
      language: candidate.language,
      license: candidate.license,
      authorGroupHash: splitGroupHash(candidate),
      rawIntent: candidate.rawText,
      rawSha256: candidate.rawSha256,
      expectedFirstAction: resolution.disposition,
      confidence: resolution.confidence,
      evidence: resolution.evidence,
      resolvedIntent: resolution.resolvedIntent,
      contract: resolution.contract ? normalizeContract(resolution.contract) : null,
      clarificationQuestions: resolution.clarificationQuestions,
      unsupportedCapabilities: resolution.unsupportedCapabilities,
      annotationId: annotation.annotationId,
      resolutionReviewId: resolution.reviewId,
    });
  }
  records.sort((left, right) => left.id.localeCompare(right.id));
  const serialized = records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
  return {
    records,
    manifest: {
      schemaVersion: "1.0",
      generatedAt: options.now ?? new Date().toISOString(),
      splitSalt,
      minimumIndependentReviews: minimumReviews,
      adjudicationRequired: requireAdjudication,
      counts: {
        annotations: annotations.length,
        exported: records.length,
        excludedNotStrategy,
        byDisposition: countBy(records, (record) => record.expectedFirstAction),
        bySplit: countBy(records, (record) => record.split),
      },
      corpusSha256: sha256(serialized),
    },
  };
}
