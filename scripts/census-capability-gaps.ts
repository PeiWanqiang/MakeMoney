import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  buildCensusReport,
  type CensusObservation,
  type CensusOutcome,
} from "../src/internet-intents/capability-census.js";
import { readJsonLines } from "../src/internet-intents/pipeline.js";
import type { InternetIntentCandidate } from "../src/internet-intents/types.js";
import { DeepSeekStrategyProgramProvider } from "../src/studio/deepseek-provider.js";
import { FileStrategySessionStore } from "../src/studio/session-store.js";
import {
  StrategyGenerationError,
  StrategyNeedsClarificationError,
  StrategyStudio,
  StrategyUnsupportedError,
} from "../src/studio/strategy-studio.js";

function parseArguments(values: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error("Arguments must use --name value pairs.");
    result.set(name.slice(2), value);
  }
  return result;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

const PIPELINE_VERSION = "capability-census-v1";

const args = parseArguments(process.argv.slice(2));
const input = resolve(args.get("input") ?? "data/internet-intents/candidates/candidates.jsonl");
const observationsPath = resolve(args.get("observations") ?? "data/internet-intents/census/observations.jsonl");
const reportPath = resolve(args.get("report") ?? "data/internet-intents/census/report.json");
const storeRoot = resolve(args.get("store") ?? "data/internet-intents/census/sessions");
const limit = positiveInteger(args.get("limit") ?? "50", "--limit");
const concurrency = positiveInteger(args.get("concurrency") ?? "2", "--concurrency");
const maxIntentChars = positiveInteger(args.get("max-intent-chars") ?? "6000", "--max-intent-chars");
const minimumScore = Number(args.get("minimum-score") ?? "0.3");
if (!Number.isFinite(minimumScore)) throw new Error("--minimum-score must be a number.");
const model = args.get("model") ?? process.env.DEEPSEEK_STRATEGY_MODEL ?? "deepseek-v4-pro";
const reportOnly = args.get("report-only") === "true";
const generator = `deepseek:${model}:${PIPELINE_VERSION}`;

const candidates = (await readJsonLines<InternetIntentCandidate>(input))
  .filter((candidate) => candidate.relevance.score >= minimumScore)
  .sort((left, right) => left.id.localeCompare(right.id));

const existing = await readJsonLines<CensusObservation>(observationsPath);
const observations = new Map(existing.map((observation) => [observation.candidateId, observation]));

function fingerprintOf(candidate: InternetIntentCandidate): string {
  return createHash("sha256")
    .update(JSON.stringify({ sha: candidate.rawSha256, generator, maxIntentChars }))
    .digest("hex");
}

const selected = candidates.slice(0, limit);
const pending = reportOnly
  ? []
  : selected.filter((candidate) => observations.get(candidate.id)?.fingerprint !== fingerprintOf(candidate));

// Constructed only when there is work to do, so re-aggregating an existing
// census needs no API key.
const provider = pending.length > 0 ? new DeepSeekStrategyProgramProvider({ model }) : null;
const store = new FileStrategySessionStore(storeRoot);
let cursor = 0;
let completed = 0;
let persistQueue = Promise.resolve();

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

function persist(): Promise<void> {
  const ordered = [...observations.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  persistQueue = persistQueue.then(async () => {
    await writeAtomic(observationsPath, `${ordered.map((item) => JSON.stringify(item)).join("\n")}\n`);
  });
  return persistQueue;
}

async function observe(candidate: InternetIntentCandidate): Promise<CensusObservation> {
  const started = performance.now();
  const intent = candidate.rawText.slice(0, maxIntentChars);
  if (!provider) throw new Error("Provider is unavailable while observations are pending.");
  const studio = new StrategyStudio({ provider, store, maxRepairAttempts: 2 });
  const base = {
    schemaVersion: "1.0" as const,
    candidateId: candidate.id,
    candidateSha256: candidate.rawSha256,
    fingerprint: fingerprintOf(candidate),
    generator,
    observedAt: new Date().toISOString(),
    sourceHost: candidate.sourceHost,
    sourceUrl: candidate.sourceUrl,
    language: candidate.language,
    relevanceScore: candidate.relevance.score,
    intentChars: intent.length,
    intentTruncated: intent.length < candidate.rawText.length,
  };

  try {
    const generated = await studio.create({
      sessionId: `census-${base.fingerprint.slice(0, 32)}`,
      intent,
    });
    return {
      ...base,
      outcome: "ready",
      opaqueConditions: generated.version.semanticVerification.extracted.opaqueConditions,
      unsupportedCapabilities: generated.version.contract.unsupportedCapabilities,
      clarificationQuestions: [],
      repairCount: generated.version.generation.repairCount,
      durationMs: Math.round(performance.now() - started),
      error: null,
    };
  } catch (error) {
    let outcome: CensusOutcome = "engine_error";
    let clarificationQuestions: string[] = [];
    let unsupportedCapabilities: string[] = [];
    if (error instanceof StrategyNeedsClarificationError) {
      outcome = "needs_clarification";
      clarificationQuestions = error.response.artifact.clarificationQuestions ?? [];
    } else if (error instanceof StrategyUnsupportedError) {
      outcome = "unsupported";
      unsupportedCapabilities = error.response.artifact.contract.unsupportedCapabilities;
    } else if (error instanceof StrategyGenerationError) {
      outcome = "generation_error";
    }
    return {
      ...base,
      outcome,
      opaqueConditions: [],
      unsupportedCapabilities,
      clarificationQuestions,
      repairCount: null,
      durationMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function worker(): Promise<void> {
  while (cursor < pending.length) {
    const candidate = pending[cursor];
    cursor += 1;
    if (!candidate) return;
    const observation = await observe(candidate);
    observations.set(candidate.id, observation);
    completed += 1;
    await persist();
    process.stdout.write(`[${completed}/${pending.length}] ${candidate.id} ${observation.outcome}\n`);
  }
}

if (pending.length > 0) {
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
  await persistQueue;
}

const selectedIds = new Set(selected.map((candidate) => candidate.id));
const reported = [...observations.values()].filter((observation) => selectedIds.has(observation.candidateId));
const report = {
  schemaVersion: "1.0",
  census: "internet-intent-capability-gaps",
  pipelineVersion: PIPELINE_VERSION,
  model,
  updatedAt: new Date().toISOString(),
  corpus: { input, total: candidates.length, selected: selected.length, observed: reported.length, minimumScore },
  caveats: [
    "Not an accuracy measurement and not a golden label set.",
    "opaqueConditions is a deterministic engine signal; unsupportedCapabilities and clarificationQuestions are model-authored free text.",
    "Candidates come from Stack Exchange and GitHub, so the distribution is skewed and does not represent target-user demand.",
    "Non-strategy candidates (debugging questions, framework READMEs) are still counted and inflate clarification and unsupported outcomes.",
  ],
  ...buildCensusReport(reported),
};
await writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);

process.stdout.write(`\nObserved ${reported.length} candidates. Report: ${reportPath}\n`);
process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
