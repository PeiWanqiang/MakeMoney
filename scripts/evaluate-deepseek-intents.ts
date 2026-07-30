import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { GOLDEN_STRATEGY_CASES } from "../src/semantics/golden-cases.js";
import { compareStrategyContracts, type SemanticDiagnostic, type StrategyContract } from "../src/semantics/contract.js";
import { DeepSeekStrategyProgramProvider } from "../src/studio/deepseek-provider.js";
import { FileStrategySessionStore } from "../src/studio/session-store.js";
import {
  StrategyGenerationError,
  StrategyNeedsClarificationError,
  StrategyStudio,
} from "../src/studio/strategy-studio.js";
import type {
  ProviderTokenUsage,
  StrategyProgramProvider,
  StrategyProviderRequest,
  StrategyProviderResponse,
} from "../src/studio/types.js";

interface Arguments {
  model: string;
  output: string;
  concurrency: number;
  offset: number;
  limit: number;
  caseId?: string;
  key?: string;
  keys?: string[];
  resume: boolean;
}

interface MeteredCall {
  mode: StrategyProviderRequest["mode"];
  attempt: number;
  durationMs: number;
  responseId?: string;
  usage?: ProviderTokenUsage;
  error?: string;
}

interface EvaluationItem {
  key: string;
  fingerprint: string;
  caseId: string;
  intentIndex: number;
  intent: string;
  expectedContract: StrategyContract;
}

interface EvaluationResult {
  key: string;
  fingerprint: string;
  caseId: string;
  intentIndex: number;
  intent: string;
  status: "passed" | "gold_mismatch" | "needs_clarification" | "generation_error" | "provider_error";
  startedAt: string;
  durationMs: number;
  model: string;
  calls: MeteredCall[];
  usage: ProviderTokenUsage;
  estimatedCostUsd: number;
  expectedContract: StrategyContract;
  actualContract?: StrategyContract;
  contractDiagnostics: SemanticDiagnostic[];
  repairCount?: number;
  sourceHash?: string;
  error?: string;
  failedAttempts?: StrategyGenerationError["attempts"];
}

interface EvaluationReport {
  schemaVersion: "1.0";
  evaluation: "deepseek-golden-intents";
  model: string;
  updatedAt: string;
  pricing: typeof PRICING;
  corpus: { strategies: number; intents: number };
  selection: { offset: number; limit: number; caseId?: string; key?: string; keys?: string[] };
  summary: ReturnType<typeof summarize>;
  results: EvaluationResult[];
}

const PRICING = {
  currency: "USD",
  unitTokens: 1_000_000,
  asOf: "2026-07-30",
  source: "https://api-docs.deepseek.com/quick_start/pricing/",
  models: {
    "deepseek-v4-pro": { cachedInput: 0.003625, uncachedInput: 0.435, output: 0.87 },
    "deepseek-v4-flash": { cachedInput: 0.0028, uncachedInput: 0.14, output: 0.28 },
  },
} as const;

const PIPELINE_VERSION = "2026-07-30.4";

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${name} must be a non-negative integer.`);
  return parsed;
}

function parseArguments(values: string[]): Arguments {
  const options = new Map<string, string | true>();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token?.startsWith("--")) throw new Error(`Unexpected argument '${token ?? ""}'.`);
    const name = token.slice(2);
    if (name === "no-resume") {
      options.set(name, true);
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`--${name} requires a value.`);
    options.set(name, next);
    index += 1;
  }
  const model = String(options.get("model") ?? process.env.DEEPSEEK_STRATEGY_MODEL ?? "deepseek-v4-pro");
  const output = resolve(String(options.get("output") ?? `data/reports/semantic-evals/${model}-golden-intents.json`));
  return {
    model,
    output,
    concurrency: Math.max(1, parsePositiveInteger(options.get("concurrency") as string | undefined, 2, "concurrency")),
    offset: parsePositiveInteger(options.get("offset") as string | undefined, 0, "offset"),
    limit: parsePositiveInteger(options.get("limit") as string | undefined, Number.MAX_SAFE_INTEGER, "limit"),
    ...(options.has("case") ? { caseId: String(options.get("case")) } : {}),
    ...(options.has("key") ? { key: String(options.get("key")) } : {}),
    ...(options.has("keys") ? { keys: String(options.get("keys")).split(",").map((key) => key.trim()).filter(Boolean) } : {}),
    resume: !options.has("no-resume"),
  };
}

function emptyUsage(): ProviderTokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, reasoningTokens: 0 };
}

function sumUsage(calls: MeteredCall[]): ProviderTokenUsage {
  return calls.reduce((total, call) => {
    const usage = call.usage;
    if (!usage) return total;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.totalTokens += usage.totalTokens;
    total.cachedInputTokens = (total.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0);
    total.uncachedInputTokens = (total.uncachedInputTokens ?? 0) + (usage.uncachedInputTokens ?? usage.inputTokens - (usage.cachedInputTokens ?? 0));
    total.reasoningTokens = (total.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
    return total;
  }, emptyUsage());
}

function estimateCost(model: string, usage: ProviderTokenUsage): number {
  const price = PRICING.models[model as keyof typeof PRICING.models];
  if (!price) return 0;
  const cached = usage.cachedInputTokens ?? 0;
  const uncached = usage.uncachedInputTokens ?? Math.max(0, usage.inputTokens - cached);
  return (cached * price.cachedInput + uncached * price.uncachedInput + usage.outputTokens * price.output) / PRICING.unitTokens;
}

class MeteredProvider implements StrategyProgramProvider {
  readonly calls: MeteredCall[] = [];

  constructor(private readonly delegate: StrategyProgramProvider) {}

  async generate(request: StrategyProviderRequest): Promise<StrategyProviderResponse> {
    const start = performance.now();
    try {
      const response = await this.delegate.generate(request);
      this.calls.push({
        mode: request.mode,
        attempt: request.attempt,
        durationMs: Math.round(performance.now() - start),
        ...(response.responseId === undefined ? {} : { responseId: response.responseId }),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
      });
      return response;
    } catch (error) {
      this.calls.push({
        mode: request.mode,
        attempt: request.attempt,
        durationMs: Math.round(performance.now() - start),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

function corpus(): EvaluationItem[] {
  return GOLDEN_STRATEGY_CASES.flatMap((item) => item.intents.map((intent, index) => {
    const key = `${item.id}:${index + 1}`;
    return {
      key,
      fingerprint: createHash("sha256").update(JSON.stringify({
        pipelineVersion: PIPELINE_VERSION,
        key,
        intent,
        contract: item.contract,
      })).digest("hex"),
      caseId: item.id,
      intentIndex: index + 1,
      intent,
      expectedContract: item.contract,
    };
  }));
}

function summarize(results: EvaluationResult[]) {
  const usage = results.reduce((total, result) => {
    total.inputTokens += result.usage.inputTokens;
    total.outputTokens += result.usage.outputTokens;
    total.totalTokens += result.usage.totalTokens;
    total.cachedInputTokens = (total.cachedInputTokens ?? 0) + (result.usage.cachedInputTokens ?? 0);
    total.uncachedInputTokens = (total.uncachedInputTokens ?? 0) + (result.usage.uncachedInputTokens ?? 0);
    total.reasoningTokens = (total.reasoningTokens ?? 0) + (result.usage.reasoningTokens ?? 0);
    return total;
  }, emptyUsage());
  const durationValues = results.map((result) => result.durationMs).sort((left, right) => left - right);
  const percentile = (fraction: number): number => durationValues.length === 0
    ? 0
    : durationValues[Math.min(durationValues.length - 1, Math.ceil(durationValues.length * fraction) - 1)] ?? 0;
  return {
    completed: results.length,
    passed: results.filter((result) => result.status === "passed").length,
    passRate: results.length === 0 ? 0 : results.filter((result) => result.status === "passed").length / results.length,
    goldMismatch: results.filter((result) => result.status === "gold_mismatch").length,
    needsClarification: results.filter((result) => result.status === "needs_clarification").length,
    generationError: results.filter((result) => result.status === "generation_error").length,
    providerError: results.filter((result) => result.status === "provider_error").length,
    repairs: results.reduce((sum, result) => sum + (result.repairCount ?? 0), 0),
    latencyMs: { p50: percentile(0.5), p95: percentile(0.95), max: durationValues.at(-1) ?? 0 },
    usage,
    estimatedCostUsd: results.reduce((sum, result) => sum + result.estimatedCostUsd, 0),
  };
}

async function readExisting(path: string, enabled: boolean): Promise<EvaluationResult[]> {
  if (!enabled) return [];
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<EvaluationReport>;
    return Array.isArray(value.results) ? value.results : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const options = parseArguments(process.argv.slice(2));
const allItems = corpus();
const filtered = allItems.filter((item) =>
  (options.caseId === undefined || item.caseId === options.caseId) &&
  (options.key === undefined || item.key === options.key) &&
  (options.keys === undefined || options.keys.includes(item.key))
);
if (filtered.length === 0) throw new Error(`No golden item matched '${options.key ?? options.keys?.join(",") ?? options.caseId ?? "selection"}'.`);
const selected = filtered.slice(options.offset, options.offset + options.limit);
const itemByKey = new Map(allItems.map((item) => [item.key, item]));
const existing = (await readExisting(options.output, options.resume))
  .filter((result) => {
    const item = itemByKey.get(result.key);
    return item !== undefined && result.fingerprint === item.fingerprint;
  })
  .map((result): EvaluationResult => {
    const item = itemByKey.get(result.key);
    if (!item || !result.actualContract || !["passed", "gold_mismatch"].includes(result.status)) return result;
    const contractDiagnostics = compareStrategyContracts(item.expectedContract, result.actualContract);
    return {
      ...result,
      status: contractDiagnostics.length === 0 ? "passed" : "gold_mismatch",
      contractDiagnostics,
    };
  });
const resultsByKey = new Map(existing.map((result) => [result.key, result]));
const pending = selected.filter((item) => !resultsByKey.has(item.key));
const provider = new DeepSeekStrategyProgramProvider({ model: options.model });
const sessionRoot = resolve(dirname(options.output), "sessions");
await mkdir(dirname(options.output), { recursive: true });
const reportSelection = {
  offset: options.offset,
  limit: Math.min(options.limit, selected.length),
  ...(options.caseId === undefined ? {} : { caseId: options.caseId }),
  ...(options.key === undefined ? {} : { key: options.key }),
  ...(options.keys === undefined ? {} : { keys: options.keys }),
};
let persistQueue = Promise.resolve();

function orderedResults(): EvaluationResult[] {
  const order = new Map(allItems.map((item, index) => [item.key, index]));
  return [...resultsByKey.values()].sort((left, right) => (order.get(left.key) ?? 0) - (order.get(right.key) ?? 0));
}

function persist(): Promise<void> {
  const results = orderedResults();
  const report: EvaluationReport = {
    schemaVersion: "1.0",
    evaluation: "deepseek-golden-intents",
    model: options.model,
    updatedAt: new Date().toISOString(),
    pricing: PRICING,
    corpus: { strategies: GOLDEN_STRATEGY_CASES.length, intents: allItems.length },
    selection: reportSelection,
    summary: summarize(results),
    results,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  persistQueue = persistQueue.then(async () => {
    const temporary = `${options.output}.tmp`;
    await writeFile(temporary, serialized, "utf8");
    await rename(temporary, options.output);
  });
  return persistQueue;
}

let cursor = 0;
async function evaluate(item: EvaluationItem): Promise<EvaluationResult> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const metered = new MeteredProvider(provider);
  const studio = new StrategyStudio({
    provider: metered,
    store: new FileStrategySessionStore(sessionRoot),
    maxRepairAttempts: 2,
  });
  const base = {
    key: item.key,
    fingerprint: item.fingerprint,
    caseId: item.caseId,
    intentIndex: item.intentIndex,
    intent: item.intent,
    startedAt,
    model: options.model,
    expectedContract: item.expectedContract,
  };
  try {
    const generated = await studio.create({
      sessionId: `eval-${item.caseId}-${item.intentIndex}-${item.fingerprint.slice(0, 12)}`,
      intent: item.intent,
    });
    const contractDiagnostics = compareStrategyContracts(item.expectedContract, generated.version.contract);
    const usage = sumUsage(metered.calls);
    return {
      ...base,
      status: contractDiagnostics.length === 0 ? "passed" : "gold_mismatch",
      durationMs: Math.round(performance.now() - started),
      calls: metered.calls,
      usage,
      estimatedCostUsd: estimateCost(options.model, usage),
      actualContract: generated.version.contract,
      contractDiagnostics,
      repairCount: generated.version.generation.repairCount,
      sourceHash: generated.version.sourceHash,
    };
  } catch (error) {
    const usage = sumUsage(metered.calls);
    const common = {
      ...base,
      durationMs: Math.round(performance.now() - started),
      calls: metered.calls,
      usage,
      estimatedCostUsd: estimateCost(options.model, usage),
      contractDiagnostics: [] as SemanticDiagnostic[],
    };
    if (error instanceof StrategyNeedsClarificationError) return {
      ...common,
      status: "needs_clarification",
      actualContract: error.response.artifact.contract,
      error: error.message,
    };
    if (error instanceof StrategyGenerationError) return {
      ...common,
      status: "generation_error",
      repairCount: error.attempts.length - 1,
      failedAttempts: error.attempts,
      error: error.message,
    };
    return { ...common, status: "provider_error", error: error instanceof Error ? error.message : String(error) };
  }
}

async function worker(): Promise<void> {
  while (cursor < pending.length) {
    const item = pending[cursor];
    cursor += 1;
    if (!item) return;
    const result = await evaluate(item);
    resultsByKey.set(item.key, result);
    await persist();
    const selectedCompleted = selected.filter((candidate) => resultsByKey.has(candidate.key));
    const selectedResults = selectedCompleted.map((candidate) => resultsByKey.get(candidate.key)).filter((value): value is EvaluationResult => value !== undefined);
    const summary = summarize(selectedResults);
    console.log(JSON.stringify({ progress: `${selectedResults.length}/${selected.length}`, latest: { key: result.key, status: result.status }, summary }));
  }
}

await Promise.all(Array.from({ length: Math.min(options.concurrency, pending.length) }, () => worker()));
await persist();
const selectedResults = selected.map((item) => resultsByKey.get(item.key)).filter((value): value is EvaluationResult => value !== undefined);
const finalSummary = summarize(selectedResults);
console.log(JSON.stringify({ output: options.output, selection: reportSelection, summary: finalSummary }, null, 2));
if (finalSummary.completed !== selected.length || finalSummary.passed !== selected.length) process.exitCode = 1;
