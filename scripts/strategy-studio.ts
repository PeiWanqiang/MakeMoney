import { resolve } from "node:path";

import { DatasetBacktestEvaluator } from "../src/studio/dataset-backtest-evaluator.js";
import { DeepSeekStrategyProgramProvider } from "../src/studio/deepseek-provider.js";
import { OpenAIStrategyProgramProvider } from "../src/studio/openai-provider.js";
import { FileStrategySessionStore } from "../src/studio/session-store.js";
import { StrategyGenerationError, StrategyNeedsClarificationError, StrategyStudio, StrategyUnsupportedError } from "../src/studio/strategy-studio.js";

type Arguments = Record<string, string | boolean>;

function parseArguments(values: string[]): { command: string; options: Arguments } {
  const command = values[0] ?? "";
  const options: Arguments = {};
  for (let index = 1; index < values.length; index += 1) {
    const item = values[index];
    if (!item?.startsWith("--")) throw new Error(`Unexpected argument '${item ?? ""}'.`);
    const key = item.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

function stringOption(options: Arguments, key: string, required = false): string | undefined {
  const value = options[key];
  if (typeof value === "string") return value;
  if (required) throw new Error(`--${key} is required.`);
  return undefined;
}

function usage(): never {
  throw new Error(`Usage:
  npm run strategy:studio -- new --intent "..." [--session ID] [--dataset PATH] [--interval 1m|15m|1h|4h]
  npm run strategy:studio -- revise --session ID --intent "..." [--dataset PATH] [--interval 1m|15m|1h|4h]
  npm run strategy:studio -- show --session ID [--version ID]

Default provider: deepseek. Set DEEPSEEK_API_KEY in the environment.
Optional: --provider deepseek|openai and --model MODEL_ID.`);
}

const { command, options } = parseArguments(process.argv.slice(2));
if (!command) usage();
const store = new FileStrategySessionStore(stringOption(options, "root") ?? "data/strategy-sessions");

if (command === "show") {
  const sessionId = stringOption(options, "session", true) as string;
  const versionId = stringOption(options, "version");
  const session = await store.loadSession(sessionId);
  const version = versionId
    ? await store.loadVersion(sessionId, versionId)
    : await store.loadLatestVersion(sessionId);
  console.log(JSON.stringify({ session, version }, null, 2));
  process.exit(0);
}

if (command !== "new" && command !== "revise") usage();
const intent = stringOption(options, "intent", true) as string;
const dataset = stringOption(options, "dataset");
const interval = stringOption(options, "interval") ?? "4h";
if (!(["1m", "15m", "1h", "4h"] as string[]).includes(interval)) {
  throw new Error(`Unsupported interval '${interval}'.`);
}
const evaluator = dataset
  ? new DatasetBacktestEvaluator({
      datasetPath: resolve(dataset),
      interval: interval as "1m" | "15m" | "1h" | "4h",
    })
  : undefined;
const requestedModel = stringOption(options, "model");
const providerName = stringOption(options, "provider") ?? process.env.STRATEGY_PROVIDER ?? "deepseek";
const provider = providerName === "deepseek"
  ? new DeepSeekStrategyProgramProvider(requestedModel === undefined ? {} : { model: requestedModel })
  : providerName === "openai"
    ? new OpenAIStrategyProgramProvider(requestedModel === undefined ? {} : { model: requestedModel })
    : (() => { throw new Error(`Unsupported provider '${providerName}'. Use deepseek or openai.`); })();
const studio = new StrategyStudio({
  provider,
  store,
  ...(evaluator === undefined ? {} : { evaluator }),
});

try {
  const requestedSessionId = stringOption(options, "session");
  const requestedVersionId = stringOption(options, "version");
  const result = command === "new"
    ? await studio.create({
        intent,
        ...(requestedSessionId === undefined ? {} : { sessionId: requestedSessionId }),
      })
    : await studio.revise({
        sessionId: requestedSessionId ?? (stringOption(options, "session", true) as string),
        intent,
        ...(requestedVersionId === undefined ? {} : { parentVersionId: requestedVersionId }),
      });
  console.log(JSON.stringify({
    sessionId: result.session.sessionId,
    versionId: result.version.versionId,
    ordinal: result.version.ordinal,
    sourceHash: result.version.sourceHash,
    contract: result.version.contract,
    semanticVerification: result.version.semanticVerification,
    explanation: result.version.explanation,
    assumptions: result.version.assumptions,
    warnings: result.version.warnings,
    changeSummary: result.version.changeSummary,
    sourceDiff: result.version.sourceDiff,
    generation: result.version.generation,
    evaluation: result.version.evaluation,
    source: result.version.source,
  }, null, 2));
} catch (error) {
  if (error instanceof StrategyGenerationError) {
    console.error(JSON.stringify({ error: error.message, attempts: error.attempts }, null, 2));
    process.exitCode = 1;
  } else if (error instanceof StrategyNeedsClarificationError) {
    console.error(JSON.stringify({
      error: error.message,
      status: error.response.artifact.status,
      clarificationQuestions: error.response.artifact.clarificationQuestions ?? [],
      assumptions: error.response.artifact.assumptions,
      warnings: error.response.artifact.warnings,
    }, null, 2));
    process.exitCode = 2;
  } else if (error instanceof StrategyUnsupportedError) {
    console.error(JSON.stringify({
      error: error.message,
      status: error.response.artifact.status,
      unsupportedCapabilities: error.response.artifact.contract.unsupportedCapabilities,
      assumptions: error.response.artifact.assumptions,
      warnings: error.response.artifact.warnings,
    }, null, 2));
    process.exitCode = 3;
  } else {
    throw error;
  }
}
