import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { assessGoldenOutcome, type InternetIntentActualAction } from "../src/internet-intents/golden-evaluation.js";
import { readJsonLines } from "../src/internet-intents/pipeline.js";
import type { InternetIntentGoldenRecord, InternetIntentSplit } from "../src/internet-intents/review.js";
import { evaluateStrategyMutations } from "../src/semantics/mutation-testing.js";
import { DeepSeekStrategyProgramProvider } from "../src/studio/deepseek-provider.js";
import { FileStrategySessionStore } from "../src/studio/session-store.js";
import {
  StrategyGenerationError,
  StrategyNeedsClarificationError,
  StrategyStudio,
  StrategyUnsupportedError,
} from "../src/studio/strategy-studio.js";
import type { ProviderTokenUsage, StrategyProgramProvider, StrategyProviderRequest, StrategyProviderResponse } from "../src/studio/types.js";

interface EvaluationResult {
  id: string;
  fingerprint: string;
  split: InternetIntentSplit;
  expectedAction: InternetIntentGoldenRecord["expectedFirstAction"];
  actualAction: InternetIntentActualAction;
  status: ReturnType<typeof assessGoldenOutcome>["status"];
  actionMatched: boolean;
  strictPassed: boolean;
  requiresManualReview: boolean;
  contractDiagnostics: ReturnType<typeof assessGoldenOutcome>["contractDiagnostics"];
  semanticDiagnostics: unknown[];
  expectedClarificationQuestions: string[];
  actualClarificationQuestions: string[];
  expectedUnsupportedCapabilities: string[];
  actualUnsupportedCapabilities: string[];
  mutation: { total: number; killed: number; killRate: number } | null;
  repairCount: number | null;
  durationMs: number;
  usage: ProviderTokenUsage;
  error: string | null;
}

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

function nonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

function emptyUsage(): ProviderTokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addUsage(total: ProviderTokenUsage, usage: ProviderTokenUsage | undefined): void {
  if (!usage) return;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.totalTokens += usage.totalTokens;
  total.cachedInputTokens = (total.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0);
  total.uncachedInputTokens = (total.uncachedInputTokens ?? 0) + (usage.uncachedInputTokens ?? 0);
  total.reasoningTokens = (total.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
}

class MeteredProvider implements StrategyProgramProvider {
  readonly usage = emptyUsage();
  constructor(private readonly delegate: StrategyProgramProvider) {}
  async generate(request: StrategyProviderRequest): Promise<StrategyProviderResponse> {
    const response = await this.delegate.generate(request);
    addUsage(this.usage, response.usage);
    return response;
  }
}

async function readReport(path: string): Promise<EvaluationResult[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { results?: EvaluationResult[] };
    return Array.isArray(parsed.results) ? parsed.results : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const args = parseArguments(process.argv.slice(2));
const input = resolve(args.get("input") ?? "data/internet-intents/golden/golden.jsonl");
const split = (args.get("split") ?? "development") as InternetIntentSplit;
if (!["development", "validation", "blind"].includes(split)) throw new Error("--split must be development, validation or blind.");
if (split === "blind" && args.get("allow-blind") !== "true") throw new Error("Blind evaluation requires explicit --allow-blind true.");
const output = resolve(args.get("output") ?? `data/internet-intents/evaluations/deepseek-real-intents-${split}.json`);
const limit = nonNegativeInteger(args.get("limit") ?? String(Number.MAX_SAFE_INTEGER), "--limit");
const concurrency = Math.max(1, nonNegativeInteger(args.get("concurrency") ?? "2", "--concurrency"));
const model = args.get("model") ?? process.env.DEEPSEEK_STRATEGY_MODEL ?? "deepseek-v4-pro";
const pipelineVersion = "real-intent-eval-v1";
const all = await readJsonLines<InternetIntentGoldenRecord>(input);
const selected = all.filter((item) => item.split === split).slice(0, limit);
if (selected.length === 0) throw new Error(`No frozen golden records found for split '${split}'. Complete review and export first.`);
const existing = await readReport(output);
const results = new Map(existing.map((item) => [item.id, item]));
const fingerprints = new Map(selected.map((item) => [item.id, createHash("sha256").update(JSON.stringify({ pipelineVersion, model, item })).digest("hex")]));
const pending = selected.filter((item) => results.get(item.id)?.fingerprint !== fingerprints.get(item.id));
const provider = new DeepSeekStrategyProgramProvider({ model });
const storeRoot = resolve(dirname(output), "sessions");
await mkdir(dirname(output), { recursive: true });
let cursor = 0;
let persistQueue = Promise.resolve();

function summary(values: EvaluationResult[]) {
  const usage = emptyUsage();
  for (const item of values) addUsage(usage, item.usage);
  return {
    completed: values.length,
    firstActionCorrect: values.filter((item) => item.actionMatched).length,
    firstActionAccuracy: values.length === 0 ? 0 : values.filter((item) => item.actionMatched).length / values.length,
    strictPassed: values.filter((item) => item.strictPassed).length,
    manualReviewRequired: values.filter((item) => item.requiresManualReview).length,
    engineErrors: values.filter((item) => item.status === "engine_error").length,
    byStatus: Object.fromEntries([...new Set(values.map((item) => item.status))].sort().map((status) => [status, values.filter((item) => item.status === status).length])),
    usage,
  };
}

function persist(): Promise<void> {
  const selectedResults = selected.map((item) => results.get(item.id)).filter((item): item is EvaluationResult => item !== undefined);
  const report = {
    schemaVersion: "1.0",
    evaluation: "deepseek-real-internet-intents",
    pipelineVersion,
    model,
    split,
    updatedAt: new Date().toISOString(),
    corpus: { input, total: all.length, selected: selected.length },
    summary: summary(selectedResults),
    results: selectedResults,
  };
  persistQueue = persistQueue.then(async () => {
    const temporary = `${output}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await rename(temporary, output);
  });
  return persistQueue;
}

async function evaluate(item: InternetIntentGoldenRecord): Promise<EvaluationResult> {
  const started = performance.now();
  const metered = new MeteredProvider(provider);
  const studio = new StrategyStudio({ provider: metered, store: new FileStrategySessionStore(storeRoot), maxRepairAttempts: 2 });
  const fingerprint = fingerprints.get(item.id) as string;
  const common = {
    id: item.id,
    fingerprint,
    split: item.split,
    expectedAction: item.expectedFirstAction,
    expectedClarificationQuestions: item.clarificationQuestions,
    expectedUnsupportedCapabilities: item.unsupportedCapabilities,
  };
  try {
    const generated = await studio.create({ sessionId: `real-${fingerprint.slice(0, 32)}`, intent: item.rawIntent });
    const mutation = await evaluateStrategyMutations(generated.version.source, generated.version.contract);
    const assessment = assessGoldenOutcome(item, {
      action: "ready",
      contract: generated.version.contract,
      semanticVerified: generated.version.semanticVerification.ok,
      mutationKillRate: mutation.killRate,
    });
    return {
      ...common,
      actualAction: "ready",
      ...assessment,
      semanticDiagnostics: generated.version.semanticVerification.diagnostics,
      actualClarificationQuestions: [],
      actualUnsupportedCapabilities: [],
      mutation: { total: mutation.total, killed: mutation.killed, killRate: mutation.killRate },
      repairCount: generated.version.generation.repairCount,
      durationMs: Math.round(performance.now() - started),
      usage: metered.usage,
      error: null,
    };
  } catch (error) {
    let actualAction: InternetIntentActualAction = "engine_error";
    let questions: string[] = [];
    let capabilities: string[] = [];
    if (error instanceof StrategyNeedsClarificationError) {
      actualAction = "needs_clarification";
      questions = error.response.artifact.clarificationQuestions ?? [];
    } else if (error instanceof StrategyUnsupportedError) {
      actualAction = "unsupported";
      capabilities = error.response.artifact.contract.unsupportedCapabilities;
    }
    const assessment = assessGoldenOutcome(item, { action: actualAction, contract: null, semanticVerified: false, mutationKillRate: null });
    return {
      ...common,
      actualAction,
      ...assessment,
      semanticDiagnostics: [],
      actualClarificationQuestions: questions,
      actualUnsupportedCapabilities: capabilities,
      mutation: null,
      repairCount: error instanceof StrategyGenerationError ? Math.max(0, error.attempts.length - 1) : null,
      durationMs: Math.round(performance.now() - started),
      usage: metered.usage,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function worker(): Promise<void> {
  while (cursor < pending.length) {
    const item = pending[cursor];
    cursor += 1;
    if (!item) return;
    const result = await evaluate(item);
    results.set(item.id, result);
    await persist();
    const current = selected.map((candidate) => results.get(candidate.id)).filter((value): value is EvaluationResult => value !== undefined);
    console.log(JSON.stringify({ progress: `${current.length}/${selected.length}`, latest: { id: item.id, status: result.status }, summary: summary(current) }));
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
await persist();
const final = selected.map((item) => results.get(item.id)).filter((value): value is EvaluationResult => value !== undefined);
console.log(JSON.stringify({ output, split, summary: summary(final) }, null, 2));
if (final.length !== selected.length || final.some((item) => item.status === "engine_error" || item.status === "first_action_mismatch" || item.status === "contract_mismatch" || item.status === "semantic_failure" || item.status === "mutation_failure")) process.exitCode = 1;
