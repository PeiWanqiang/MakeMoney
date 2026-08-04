import { strFromU8, unzipSync } from "fflate";
import type { Identity } from "./auth";
import { decodeJson, HotPromiseCache, type ObjectCacheBucket, readObjectJson, sha256Text, writeObjectJson } from "./cache";
import { BusyError, ConcurrencyGate } from "./concurrency";
import { ensureOwnershipColumns } from "./schema-upgrade";

export interface BacktestEnv {
  DB: D1Database;
  CACHE?: ObjectCacheBucket;
  ASSETS?: Fetcher;
  /**
   * When set, `/api/backtest/run` proxies execution to the Node backtest
   * service (`services/backtest/`, `npm run backtest:service`). The program is
   * compiled, type-checked and run in the QuickJS sandbox as the single engine;
   * the Web contract interpreter remains only for the shadow comparison and the
   * unset-flag fallback.
   */
  BACKTEST_SERVICE_URL?: string;
  /** "true" runs the legacy contract interpreter in parallel and logs divergence. */
  BACKTEST_SHADOW_MODE?: string;
}

type Timeframe = "1m" | "15m" | "1h" | "4h";
type PositionSide = "flat" | "long" | "short";

interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ContractDecision {
  type: "open" | "close";
  side: "long" | "short" | null;
  sizeKind: "riskPercent" | "equityPercent" | "fixedNotional" | null;
  sizeValue: number | null;
  stopLossPercent: number | null;
  takeProfitRiskReward: number | null;
}

interface ContractRule {
  when: string[];
  decision: ContractDecision;
}

interface StrategyContract {
  schemaVersion: "1.0";
  timeframe: Timeframe;
  rules: ContractRule[];
  unsupportedCapabilities?: string[];
}

type ParameterKind = "integer" | "number";
type ParameterUnit = "bars" | "ratio" | "riskReward" | "quote" | "value";

interface ParameterDefinition {
  id: string;
  label: string;
  context: string;
  value: number;
  kind: ParameterKind;
  unit: ParameterUnit;
  suggestedMin: number;
  suggestedMax: number;
  suggestedSteps: number;
  hardMin: number;
  hardMax: number;
  target:
    | { kind: "conditionNumber"; ruleIndex: number; conditionIndex: number; numberIndex: number }
    | { kind: "decisionField"; ruleIndex: number; field: "sizeValue" | "stopLossPercent" | "takeProfitRiskReward" };
}

interface PublicParameterDefinition extends Omit<ParameterDefinition, "target" | "hardMin" | "hardMax"> {
  hardBounds: { min: number; max: number };
}

interface ParameterSelection {
  id: string;
  min: number;
  max: number;
  steps: number;
}

interface OptimizationMetrics {
  netReturn: number;
  maximumDrawdown: number;
  sharpe: number | null;
  winRate: number | null;
  profitFactor: number | null;
  tradeCount: number;
}

interface OptimizationTrial {
  id: string;
  parameters: Record<string, number>;
  train: OptimizationMetrics;
  validation: OptimizationMetrics;
  score: number;
  pareto: boolean;
  isBaseline: boolean;
}

interface WalkForwardFold {
  id: string;
  trainBars: number;
  validationBars: number;
  validationStart: string;
  validationEnd: string;
  baseline: OptimizationMetrics;
  candidate: OptimizationMetrics;
  passed: boolean;
}

interface SensitivityPoint {
  parameterId: string;
  direction: "lower" | "higher";
  value: number;
  metrics: OptimizationMetrics;
  retainedFraction: number | null;
  passed: boolean;
}

interface CostStressPoint {
  id: "base" | "double" | "severe";
  label: string;
  takerFeeRate: number;
  slippageBps: number;
  metrics: OptimizationMetrics;
  passed: boolean;
}

interface RegimeEvidence {
  regime: "bull" | "bear" | "range" | "highVolatility";
  tradeCount: number;
  winRate: number | null;
  netPnl: number;
}

interface RobustnessGate {
  walkForward: { passed: boolean; positiveFolds: number; folds: WalkForwardFold[] };
  sensitivity: { passed: boolean; stablePoints: number; totalPoints: number; points: SensitivityPoint[] };
  costStress: { passed: boolean; points: CostStressPoint[] };
  regimes: RegimeEvidence[];
  multiplicity: { trialCount: number; selectionAdjustedSharpe: number | null; warning: string | null };
  preBlindPassed: boolean;
  failedChecks: string[];
}

interface OptimizationCoreResult {
  schemaVersion: "optimization-2.0";
  semanticLockHash: string;
  split: {
    trainStart: string;
    trainEnd: string;
    validationStart: string;
    validationEnd: string;
    blindStart: string;
    blindEnd: string;
    trainBars: number;
    validationBars: number;
    blindBars: number;
  };
  objective: "balanced" | "return" | "drawdown";
  trials: OptimizationTrial[];
  baselineTrialId: string;
  recommendedTrialId: string;
  outcome: "improved" | "baseline_retained";
  robustness: RobustnessGate;
}

interface ClosedTrade {
  side: "long" | "short";
  entryTimestamp: number;
  exitTimestamp: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  grossPnl: number;
  fees: number;
  slippageCost: number;
  netPnl: number;
  exitReason: string;
}

interface EquityPoint {
  timestamp: number;
  equity: number;
}

interface OpenPosition {
  side: "long" | "short";
  quantity: number;
  entryTimestamp: number;
  entryPrice: number;
  entryFee: number;
  entrySlippageCost: number;
  stopPrice: number;
  takeProfitPrice: number | null;
}

interface BacktestConfig {
  initialCapital: number;
  takerFeeRate: number;
  slippageBps: number;
  maxLeverage: number;
  startTime: number;
  endTime: number;
}

interface FetchedBars {
  bars: Bar[];
  dataSource: string;
  warnings: string[];
  cache: KlineCacheStats;
}

interface KlineCacheStats {
  hot: number;
  local: number;
  object: number;
  external: number;
}

interface LoadedSegment {
  bars: Bar[] | null;
  tier: "local" | "object" | "external";
}

const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
};

const MAX_BARS = 10_000;
const KLINE_CACHE_VERSION = "klines-v1";
// Execution is unchanged, but both keys now derive from a bar-aligned window,
// so the same logical request maps to a different key than it did before. The
// optimization key matters most: the experiment id is derived from it, and that
// id is what makes the final blind test one-shot. Bumping cuts cleanly instead
// of leaving two keying schemes addressing the same experiment.
// Bumped when execution moved from the contract interpreter to the service:
// the key now carries the engine, so an old-engine cache entry cannot be served
// for a new-engine run of the same logical request.
const BACKTEST_CACHE_VERSION = "backtest-v5-engine-service";
const SERVICE_ENGINE_VERSION = "cli-sandbox-0.1.0";
// Bumped when optimization moved to the service: the experiment id derives from
// this key, and the blind test is one-shot per id, so an old-engine experiment
// must never be served to a new-engine request.
const OPTIMIZATION_CACHE_VERSION = "optimization-v4-engine-service";
const MAX_OPTIMIZATION_PARAMETERS = 4;
const MAX_OPTIMIZATION_TRIALS = 16;
const MARKET_FIELDS = new Set(["open", "high", "low", "close", "volume"]);
const HOT_KLINE_SEGMENTS = new HotPromiseCache<LoadedSegment>(48);
let backtestSchemaReady: Promise<unknown> | null = null;

/**
 * How many bars survive into the transported equity curve. The chart draws the
 * curve as one line a few hundred pixels tall, so a point per bar is roughly ten
 * times what it can resolve at the 10,000-bar cap.
 */
const MAX_EQUITY_POINTS = 1_500;

/**
 * Occupancy limits for the two endpoints that hold a full history in memory.
 * An experiment keeps its bars alive across roughly fifty inner backtests, so
 * fewer of those may overlap and the queue behind them is shorter. The retry
 * hints match the work: a backtest slot frees up in well under a second, an
 * experiment takes longer.
 */
const BACKTEST_GATE = new ConcurrencyGate(6, 24, 2);
const OPTIMIZATION_GATE = new ConcurrencyGate(2, 6, 10);

class RequestValidationError extends Error {}

/** An error whose customer-facing meaning survives the top-level catch as a stable code. */
class CodedError extends Error {
  constructor(readonly code: string, readonly params?: Record<string, string | number>) {
    super(code);
  }
}

function json(value: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...extraHeaders } });
}

/**
 * Errors travel as a stable `code` so the browser can render them in the active
 * locale. Every rejection that the caller may usefully repeat carries
 * `Retry-After`, so clients and proxies back off by a stated interval instead of
 * guessing one.
 */
function fail(code: string, status: number, params?: Record<string, string | number>, retryAfterSeconds?: number): Response {
  return json({ error: code, code, params, retryAfterSeconds }, status,
    retryAfterSeconds === undefined ? undefined : { "retry-after": String(retryAfterSeconds) });
}

function cleanString(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

interface OwnedStrategyRow {
  result_json: string;
  asset: string;
  market: string;
  intent: string;
  session_id: string;
  confirmed_at: string | null;
}

/**
 * Loads a strategy the caller is allowed to act on.
 *
 * Ownership is decided entirely from server state: the account that claimed the
 * row, or an unclaimed row belonging to the caller's own server-issued workspace
 * cookie. The returned `session_id` is the workspace id recorded when the strategy
 * was created — deterministic experiment ids derive from it, so they stay stable
 * when an anonymous strategy is later claimed by an account.
 */
async function ownedStrategy(db: D1Database, identity: Identity, strategyId: string): Promise<OwnedStrategyRow | null> {
  const clause = identity.user
    ? { sql: "(user_id = ? OR (user_id IS NULL AND session_id = ?))", bindings: [identity.user.id, identity.anonId] }
    : { sql: "(user_id IS NULL AND session_id = ?)", bindings: [identity.anonId] };
  return db.prepare(
    `SELECT result_json, asset, market, intent, session_id, confirmed_at
     FROM strategy_submissions WHERE id = ? AND archived_at IS NULL AND ${clause.sql}`,
  ).bind(strategyId, ...clause.bindings).first<OwnedStrategyRow>();
}

/** Resolves the workspace id of an experiment the caller owns, or null when they do not. */
async function ownedOptimizationSession(db: D1Database, identity: Identity, optimizationId: string): Promise<string | null> {
  const run = await db.prepare("SELECT strategy_submission_id, session_id FROM optimization_runs WHERE id = ?")
    .bind(optimizationId).first<{ strategy_submission_id: string; session_id: string }>();
  if (!run) return null;
  const strategy = await ownedStrategy(db, identity, run.strategy_submission_id);
  return strategy ? run.session_id : null;
}

function finite(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function compact(value: string): string {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      output += character;
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (!quoted && /\s/.test(character)) continue;
    output += character;
  }
  return output
    .replace(/\bcontext\.indicators\./g, "")
    .replace(/\bindicators\./g, "")
    .replace(/\bcrossedAbove\(/g, "crossAbove(")
    .replace(/\bcrossedBelow\(/g, "crossBelow(");
}

function splitArguments(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"' && value[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function findComparison(value: string): { left: string; operator: string; right: string } | null {
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"' && value[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth !== 0) continue;
    for (const operator of ["==", ">=", "<=", ">", "<"]) {
      if (value.startsWith(operator, index)) {
        return { left: value.slice(0, index), operator, right: value.slice(index + operator.length) };
      }
    }
  }
  return null;
}

function stripOuterParentheses(value: string): string {
  let output = value;
  while (output.startsWith("(") && output.endsWith(")")) {
    let depth = 0;
    let quoted = false;
    let wrapsWholeExpression = true;
    for (let index = 0; index < output.length; index += 1) {
      const character = output[index];
      if (character === '"' && output[index - 1] !== "\\") quoted = !quoted;
      if (quoted) continue;
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (depth === 0 && index < output.length - 1) {
        wrapsWholeExpression = false;
        break;
      }
    }
    if (!wrapsWholeExpression || depth !== 0) break;
    output = output.slice(1, -1);
  }
  return output;
}

function findArithmeticOperator(value: string, operators: ReadonlySet<string>): number {
  let depth = 0;
  let quoted = false;
  let last = -1;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '"' && value[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      continue;
    }
    if (depth !== 0 || !operators.has(character)) continue;
    if ((character === "+" || character === "-") && (index === 0 || "+-*/(".includes(value[index - 1]!))) continue;
    last = index;
  }
  return last;
}

function parseTimeframe(value: unknown): Timeframe {
  if (value === "1m" || value === "15m" || value === "1h" || value === "4h") return value;
  throw new Error("策略周期不受回测引擎支持");
}

function validateContract(value: unknown): StrategyContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("策略缺少机器契约");
  const contract = value as Record<string, unknown>;
  const timeframe = parseTimeframe(contract.timeframe);
  if (!Array.isArray(contract.rules) || contract.rules.length === 0 || contract.rules.length > 24) throw new Error("策略契约规则数量无效");
  const rules = contract.rules.map((rule, index) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error(`策略规则 ${index + 1} 无效`);
    const record = rule as Record<string, unknown>;
    if (!Array.isArray(record.when) || record.when.length === 0 || !record.when.every((item) => typeof item === "string")) throw new Error(`策略规则 ${index + 1} 缺少条件`);
    const decision = record.decision as Record<string, unknown> | null;
    if (!decision || !["open", "close"].includes(String(decision.type))) throw new Error(`策略规则 ${index + 1} 的动作无效`);
    if (decision.type === "open") {
      if (!["long", "short"].includes(String(decision.side))) throw new Error(`策略规则 ${index + 1} 缺少开仓方向`);
      if (!["riskPercent", "equityPercent", "fixedNotional"].includes(String(decision.sizeKind))) throw new Error(`策略规则 ${index + 1} 的仓位类型无效`);
      const sizeValue = Number(decision.sizeValue);
      const stopLossPercent = Number(decision.stopLossPercent);
      if (!Number.isFinite(sizeValue) || sizeValue <= 0) throw new Error(`策略规则 ${index + 1} 的仓位数值无效`);
      if (decision.sizeKind !== "fixedNotional" && sizeValue > 1) throw new Error(`策略规则 ${index + 1} 的仓位百分比不能超过 100%`);
      if (!Number.isFinite(stopLossPercent) || stopLossPercent <= 0 || stopLossPercent > 1) throw new Error(`策略规则 ${index + 1} 的止损比例无效`);
    }
    return { when: record.when as string[], decision: decision as unknown as ContractDecision };
  });
  return { schemaVersion: "1.0", timeframe, rules, unsupportedCapabilities: [] };
}

interface NumberToken {
  start: number;
  end: number;
  value: number;
}

function numberTokens(expression: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < expression.length;) {
    const character = expression[index]!;
    if (escaped) {
      escaped = false;
      index += 1;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      index += 1;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      index += 1;
      continue;
    }
    if (quoted || !/[\d.]/.test(character)) {
      index += 1;
      continue;
    }
    const previous = expression[index - 1] ?? "";
    if (/[A-Za-z0-9_.]/.test(previous)) {
      index += 1;
      continue;
    }
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(expression.slice(index));
    if (!match) {
      index += 1;
      continue;
    }
    const end = index + match[0].length;
    const next = expression[end] ?? "";
    if (/[A-Za-z0-9_]/.test(next)) {
      index = end;
      continue;
    }
    const value = Number(match[0]);
    if (Number.isFinite(value)) tokens.push({ start: index, end, value });
    index = end;
  }
  return tokens;
}

function callArgumentContext(expression: string, token: NumberToken): { name: string; argumentIndex: number } | null {
  const stack: Array<{ name: string; open: number }> = [];
  let quoted = false;
  for (let index = 0; index < token.start; index += 1) {
    const character = expression[index]!;
    if (character === '"' && expression[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") {
      const prefix = expression.slice(0, index).match(/([A-Za-z][A-Za-z0-9]*)\s*$/);
      stack.push({ name: prefix?.[1] ?? "", open: index });
    } else if (character === ")") stack.pop();
  }
  const active = stack.at(-1);
  if (!active?.name) return null;
  let argumentIndex = 0;
  let depth = 0;
  quoted = false;
  for (let index = active.open + 1; index < token.start; index += 1) {
    const character = expression[index]!;
    if (character === '"' && expression[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) argumentIndex += 1;
  }
  return { name: active.name, argumentIndex };
}

function parameterRange(value: number, kind: ParameterKind, unit: ParameterUnit): Pick<ParameterDefinition, "suggestedMin" | "suggestedMax" | "suggestedSteps" | "hardMin" | "hardMax"> {
  if (unit === "bars") {
    const minimum = Math.max(1, Math.floor(value * 0.5));
    const maximum = Math.min(1000, Math.max(minimum + 2, Math.ceil(value * 1.5)));
    return { suggestedMin: minimum, suggestedMax: maximum, suggestedSteps: 5, hardMin: 1, hardMax: 1000 };
  }
  if (unit === "riskReward") {
    return { suggestedMin: Math.max(0.25, value * 0.5), suggestedMax: Math.min(20, Math.max(0.5, value * 1.5)), suggestedSteps: 5, hardMin: 0.1, hardMax: 20 };
  }
  if (unit === "ratio") {
    return { suggestedMin: Math.max(0.001, value * 0.5), suggestedMax: Math.min(1, Math.max(0.01, value * 1.5)), suggestedSteps: 5, hardMin: 0.001, hardMax: 1 };
  }
  if (unit === "quote") {
    return { suggestedMin: Math.max(1, value * 0.5), suggestedMax: Math.min(100_000_000, Math.max(2, value * 1.5)), suggestedSteps: 5, hardMin: 1, hardMax: 100_000_000 };
  }
  const magnitude = Math.max(Math.abs(value), 0.01);
  const lower = value >= 0 ? Math.max(0, value - magnitude * 0.5) : value - magnitude * 0.5;
  const upper = value + magnitude * 0.5;
  return {
    suggestedMin: kind === "integer" ? Math.floor(lower) : lower,
    suggestedMax: kind === "integer" ? Math.ceil(Math.max(lower + 1, upper)) : upper,
    suggestedSteps: 5,
    hardMin: -1_000_000_000,
    hardMax: 1_000_000_000,
  };
}

function isLagArgument(context: { name: string; argumentIndex: number } | null): boolean {
  if (!context) return false;
  const lagIndex: Record<string, number> = { sma: 2, ema: 2, rsi: 2, highest: 2, lowest: 2, percentChange: 2, atr: 1, bollingerBands: 3, macd: 4 };
  return lagIndex[context.name] === context.argumentIndex;
}

function isPeriodArgument(context: { name: string; argumentIndex: number } | null): boolean {
  if (!context) return false;
  if (["sma", "ema", "rsi", "highest", "lowest", "percentChange", "bollingerBands", "macd"].includes(context.name)) {
    return context.argumentIndex === 1 || (context.name === "macd" && [2, 3].includes(context.argumentIndex));
  }
  return context.name === "atr" && context.argumentIndex === 0;
}

function isArithmeticIdentity(expression: string, token: NumberToken, context: { name: string; argumentIndex: number } | null): boolean {
  if (context || ![0, 1].includes(token.value)) return false;
  const before = expression.slice(0, token.start).trimEnd().at(-1) ?? "";
  const after = expression.slice(token.end).trimStart().at(0) ?? "";
  return ("(+-*/".includes(before) && "+-*/".includes(after))
    || ("+-*/".includes(before) && ")".includes(after));
}

function publicParameter(parameter: ParameterDefinition): PublicParameterDefinition {
  return {
    id: parameter.id,
    label: parameter.label,
    context: parameter.context,
    value: parameter.value,
    kind: parameter.kind,
    unit: parameter.unit,
    suggestedMin: parameter.suggestedMin,
    suggestedMax: parameter.suggestedMax,
    suggestedSteps: parameter.suggestedSteps,
    hardBounds: { min: parameter.hardMin, max: parameter.hardMax },
  };
}

function extractParameterSchema(contract: StrategyContract): ParameterDefinition[] {
  const parameters: ParameterDefinition[] = [];
  contract.rules.forEach((rule, ruleIndex) => {
    rule.when.forEach((condition, conditionIndex) => {
      numberTokens(condition).forEach((token, numberIndex) => {
        const call = callArgumentContext(condition, token);
        if (isLagArgument(call) || isArithmeticIdentity(condition, token, call)) return;
        const period = isPeriodArgument(call);
        const kind: ParameterKind = period ? "integer" : Number.isInteger(token.value) && Math.abs(token.value) >= 2 ? "integer" : "number";
        const unit: ParameterUnit = period ? "bars" : "value";
        const range = parameterRange(token.value, kind, unit);
        const role = period ? `${call?.name ?? "指标"} 周期` : `条件数值 ${numberIndex + 1}`;
        parameters.push({
          id: `rule.${ruleIndex}.when.${conditionIndex}.number.${numberIndex}`,
          label: `规则 ${ruleIndex + 1} · ${role}`,
          context: condition,
          value: token.value,
          kind,
          unit,
          ...range,
          target: { kind: "conditionNumber", ruleIndex, conditionIndex, numberIndex },
        });
      });
    });
    if (rule.decision.type !== "open") return;
    const decisionParameters: Array<{ field: "sizeValue" | "stopLossPercent" | "takeProfitRiskReward"; label: string; unit: ParameterUnit; value: number | null }> = [
      { field: "sizeValue", label: "开仓仓位", unit: rule.decision.sizeKind === "fixedNotional" ? "quote" : "ratio", value: rule.decision.sizeValue },
      { field: "stopLossPercent", label: "止损距离", unit: "ratio", value: rule.decision.stopLossPercent },
      { field: "takeProfitRiskReward", label: "止盈风险回报比", unit: "riskReward", value: rule.decision.takeProfitRiskReward },
    ];
    for (const item of decisionParameters) {
      if (item.value === null || !Number.isFinite(item.value)) continue;
      parameters.push({
        id: `rule.${ruleIndex}.decision.${item.field}`,
        label: `规则 ${ruleIndex + 1} · ${item.label}`,
        context: `${rule.decision.side === "long" ? "做多" : "做空"} · ${rule.decision.sizeKind}`,
        value: item.value,
        kind: "number",
        unit: item.unit,
        ...parameterRange(item.value, "number", item.unit),
        target: { kind: "decisionField", ruleIndex, field: item.field },
      });
    }
  });
  return parameters;
}

function semanticSkeleton(contract: StrategyContract): string {
  const clone = structuredClone(contract);
  const parameters = extractParameterSchema(contract);
  contract.rules.forEach((rule, ruleIndex) => {
    rule.when.forEach((expression, conditionIndex) => {
      const indices = parameters.flatMap((parameter) => parameter.target.kind === "conditionNumber"
        && parameter.target.ruleIndex === ruleIndex && parameter.target.conditionIndex === conditionIndex
        ? [parameter.target.numberIndex]
        : []);
      const tokens = numberTokens(expression);
      let skeleton = expression;
      for (const numberIndex of indices.sort((left, right) => right - left)) {
        const token = tokens[numberIndex];
        if (!token) throw new Error(`规则 ${ruleIndex + 1} 的参数位置已失效`);
        skeleton = `${skeleton.slice(0, token.start)}{PARAM}${skeleton.slice(token.end)}`;
      }
      clone.rules[ruleIndex]!.when[conditionIndex] = skeleton;
    });
  });
  for (const parameter of parameters) {
    if (parameter.target.kind === "decisionField") {
      const decision = clone.rules[parameter.target.ruleIndex]!.decision as unknown as Record<string, unknown>;
      decision[parameter.target.field] = "{PARAM}";
    }
  }
  return JSON.stringify(clone);
}

function replaceConditionNumber(expression: string, numberIndex: number, value: number): string {
  const token = numberTokens(expression)[numberIndex];
  if (!token) throw new Error("策略参数位置已经失效");
  return `${expression.slice(0, token.start)}${String(value)}${expression.slice(token.end)}`;
}

function applyParameters(contract: StrategyContract, definitions: ParameterDefinition[], values: Record<string, number>): StrategyContract {
  const clone = structuredClone(contract);
  const conditionUpdates = new Map<string, Array<{ numberIndex: number; value: number }>>();
  for (const [id, value] of Object.entries(values)) {
    const definition = definitions.find((item) => item.id === id);
    if (!definition) throw new Error(`未知策略参数 ${id}`);
    const normalized = definition.kind === "integer" ? Math.round(value) : value;
    if (!Number.isFinite(normalized) || normalized < definition.hardMin || normalized > definition.hardMax) throw new Error(`参数 ${definition.label} 超出安全范围`);
    if (definition.target.kind === "conditionNumber") {
      const { ruleIndex, conditionIndex, numberIndex } = definition.target;
      const key = `${ruleIndex}:${conditionIndex}`;
      const updates = conditionUpdates.get(key) ?? [];
      updates.push({ numberIndex, value: normalized });
      conditionUpdates.set(key, updates);
    } else {
      const decision = clone.rules[definition.target.ruleIndex]!.decision as unknown as Record<string, unknown>;
      decision[definition.target.field] = normalized;
    }
  }
  for (const [key, updates] of conditionUpdates) {
    const [ruleIndex, conditionIndex] = key.split(":").map(Number);
    let expression = clone.rules[ruleIndex]!.when[conditionIndex]!;
    for (const update of updates.sort((left, right) => right.numberIndex - left.numberIndex)) {
      expression = replaceConditionNumber(expression, update.numberIndex, update.value);
    }
    clone.rules[ruleIndex]!.when[conditionIndex] = expression;
  }
  const validated = validateContract(clone);
  if (semanticSkeleton(validated) !== semanticSkeleton(contract)) throw new Error("候选策略改变了锁定语义，实验已停止");
  return validated;
}

async function ensureBacktestSchema(db: D1Database): Promise<void> {
  if (backtestSchemaReady) {
    await backtestSchemaReady;
    return;
  }
  backtestSchemaReady = db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS backtest_runs (
      id TEXT PRIMARY KEY,
      strategy_submission_id TEXT NOT NULL,
      user_id TEXT,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      asset TEXT NOT NULL,
      market TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      initial_capital REAL NOT NULL,
      bar_count INTEGER NOT NULL,
      trade_count INTEGER NOT NULL,
      result_json TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_backtest_runs_session_created ON backtest_runs(session_id, created_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_backtest_runs_strategy ON backtest_runs(strategy_submission_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS optimization_runs (
      id TEXT PRIMARY KEY,
      strategy_submission_id TEXT NOT NULL,
      user_id TEXT,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      semantic_lock_hash TEXT NOT NULL,
      objective TEXT NOT NULL,
      trial_count INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      blind_status TEXT NOT NULL DEFAULT 'reserved',
      blind_consumed_at TEXT,
      blind_result_json TEXT,
      adopted_strategy_id TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_optimization_runs_session_created ON optimization_runs(session_id, created_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_optimization_runs_strategy ON optimization_runs(strategy_submission_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_optimization_runs_blind_status ON optimization_runs(session_id, blind_status)"),
    db.prepare("PRAGMA optimize"),
  ]).then(() => ensureOwnershipColumns(db)).catch((error) => {
    backtestSchemaReady = null;
    throw error;
  });
  await backtestSchemaReady;
}

function parseKlineRows(rows: unknown, startTime: number, endTime: number): Bar[] {
  if (!Array.isArray(rows)) return [];
  const bars: Bar[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const rawTimestamp = Number(row[0]);
    const timestamp = rawTimestamp > 100_000_000_000_000 ? Math.floor(rawTimestamp / 1000) : rawTimestamp;
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]);
    if (![timestamp, open, high, low, close, volume].every(Number.isFinite)) continue;
    if (timestamp < startTime || timestamp > endTime || high < Math.max(open, close) || low > Math.min(open, close)) continue;
    bars.push({ timestamp, open, high, low, close, volume });
  }
  return bars;
}

function finishBars(bars: Bar[], timeframe: Timeframe, endTime: number): Bar[] {
  const unique = [...new Map(bars.map((bar) => [bar.timestamp, bar])).values()].sort((left, right) => left.timestamp - right.timestamp);
  if (unique.length < 2) throw new Error("所选日期没有足够的完整K线");
  if (unique.length > MAX_BARS || (unique.length >= MAX_BARS && unique.at(-1)!.timestamp < endTime - TIMEFRAME_MS[timeframe])) {
    throw new CodedError("RANGE_TOO_LARGE", { timeframe, maxBars: MAX_BARS.toLocaleString("en-US") });
  }
  return unique;
}

async function fetchBinanceRestBars(asset: string, market: string, timeframe: Timeframe, startTime: number, endTime: number): Promise<Bar[]> {
  const path = market === "Binance Spot" ? "https://data-api.binance.vision/api/v3/klines" : "https://fapi.binance.com/fapi/v1/klines";
  const bars: Bar[] = [];
  let cursor = Math.floor(startTime / TIMEFRAME_MS[timeframe]) * TIMEFRAME_MS[timeframe];
  while (cursor <= endTime && bars.length < MAX_BARS) {
    const url = new URL(path);
    url.searchParams.set("symbol", asset);
    url.searchParams.set("interval", timeframe);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(endTime));
    url.searchParams.set("limit", String(Math.min(1500, MAX_BARS - bars.length)));
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Binance REST ${response.status}`);
    const rows = await response.json() as unknown;
    if (!Array.isArray(rows) || rows.length === 0) break;
    let newest = cursor;
    for (const bar of parseKlineRows(rows, startTime, endTime)) {
      bars.push(bar);
      newest = Math.max(newest, bar.timestamp);
    }
    const next = newest + TIMEFRAME_MS[timeframe];
    if (next <= cursor || rows.length < 1500) break;
    cursor = next;
  }
  return finishBars(bars, timeframe, endTime);
}

function utcMonthStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function nextUtcMonth(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function datePart(timestamp: number, includeDay: boolean): string {
  return new Date(timestamp).toISOString().slice(0, includeDay ? 10 : 7);
}

function archiveUrl(asset: string, market: string, timeframe: Timeframe, period: "monthly" | "daily", timestamp: number): string {
  const product = market === "Binance Spot" ? "spot" : "futures/um";
  const suffix = datePart(timestamp, period === "daily");
  return `https://data.binance.vision/data/${product}/${period}/klines/${asset}/${timeframe}/${asset}-${timeframe}-${suffix}.zip`;
}

function marketCacheKey(market: string): "spot" | "perpetual" {
  return market === "Binance Spot" ? "spot" : "perpetual";
}

function compactBars(bars: Bar[]): number[][] {
  return bars.map((bar) => [bar.timestamp, bar.open, bar.high, bar.low, bar.close, bar.volume]);
}

/**
 * Snaps a requested window out to the bar boundaries it already resolves to.
 *
 * Loaded bars are bar-aligned, so two requests a second apart over the same
 * range see byte-identical history — but the raw millisecond bounds were part of
 * the result cache key, so neither could ever reuse the other's work. That is
 * not hypothetical: `endTime` falls back to `now - one interval` whenever the
 * caller asks for an end at or past the present, which is what the workspace
 * sends the moment someone picks today as the end date.
 *
 * The rounding is chosen to select exactly the bars the unaligned bounds did.
 * `start` rounds up because a bar opening before it was already excluded, and
 * `end` rounds out to the close of the bar containing it because that bar was
 * already included. Only the cache key changes; the result does not.
 */
function alignWindow(startTime: number, endTime: number, timeframe: Timeframe): { startTime: number; endTime: number } {
  const interval = TIMEFRAME_MS[timeframe];
  return {
    startTime: Math.ceil(startTime / interval) * interval,
    endTime: Math.floor(endTime / interval) * interval + interval - 1,
  };
}

/**
 * Bars as `[timestamp, open, high, low, close]` rows for transport.
 *
 * Repeating six field names across 10,000 objects costs more than the numbers
 * themselves. Volume is dropped because the chart never reads it, and dropping a
 * field the browser ignores is free. Nothing about the executed backtest
 * changes; this is the response shape only.
 */
function wireBars(bars: Bar[]): number[][] {
  return bars.map((bar) => [bar.timestamp, bar.open, bar.high, bar.low, bar.close]);
}

/**
 * Equity curve as `[timestamp, equity]` rows, decimated to `MAX_EQUITY_POINTS`.
 *
 * Plain striding would carry the shape but can step straight over the peak and
 * the trough that the maximum drawdown on the page was measured between, which
 * would leave the chart quietly disagreeing with the number beside it. Each
 * bucket therefore keeps its extremes as well as its edges. Metrics are computed
 * from the full curve before this runs.
 */
function wireEquityCurve(points: EquityPoint[]): number[][] {
  const row = (point: EquityPoint): number[] => [point.timestamp, point.equity];
  if (points.length <= MAX_EQUITY_POINTS) return points.map(row);
  const bucketSize = Math.ceil(points.length / Math.floor(MAX_EQUITY_POINTS / 4));
  const output: number[][] = [];
  for (let start = 0; start < points.length; start += bucketSize) {
    const end = Math.min(points.length, start + bucketSize);
    let lowest = start;
    let highest = start;
    for (let index = start + 1; index < end; index += 1) {
      if (points[index]!.equity < points[lowest]!.equity) lowest = index;
      if (points[index]!.equity > points[highest]!.equity) highest = index;
    }
    for (const index of [...new Set([start, lowest, highest, end - 1])].sort((left, right) => left - right)) {
      output.push(row(points[index]!));
    }
  }
  return output;
}

async function loadArchiveSegment(
  env: BacktestEnv,
  origin: string,
  asset: string,
  market: string,
  timeframe: Timeframe,
  period: "monthly" | "daily",
  timestamp: number,
  stats: KlineCacheStats,
): Promise<Bar[] | null> {
  const suffix = datePart(timestamp, period === "daily");
  const marketKey = marketCacheKey(market);
  const cacheKey = `${KLINE_CACHE_VERSION}/${marketKey}/${asset}/${timeframe}/${period}/${suffix}.json.gz`;
  const wasHot = HOT_KLINE_SEGMENTS.has(cacheKey);
  const loaded = await HOT_KLINE_SEGMENTS.getOrLoad(cacheKey, async (): Promise<LoadedSegment> => {
    if (period === "monthly" && env.ASSETS) {
      const localUrl = new URL(`/prooftrade-data/klines/${marketKey}/${asset}/${timeframe}/${suffix}.json.gz`, origin);
      const local = await env.ASSETS.fetch(new Request(localUrl));
      if (local.ok) {
        const rows = decodeJson<unknown>(await local.arrayBuffer());
        return { bars: parseKlineRows(rows, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY), tier: "local" };
      }
    }
    const objectRows = await readObjectJson<unknown>(env.CACHE, cacheKey);
    if (objectRows) return { bars: parseKlineRows(objectRows, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY), tier: "object" };

    const response = await fetch(archiveUrl(asset, market, timeframe, period, timestamp), { headers: { accept: "application/zip" } });
    if (response.status === 404) return { bars: null, tier: "external" };
    if (!response.ok) throw new Error(`Binance archive ${response.status}`);
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const csv = Object.entries(files).find(([name]) => name.endsWith(".csv"))?.[1];
    if (!csv) throw new Error("Binance archive missing CSV");
    const rows = strFromU8(csv).split(/\r?\n/).map((line) => line.split(","));
    const bars = parseKlineRows(rows, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
    await writeObjectJson(env.CACHE, cacheKey, compactBars(bars));
    return { bars, tier: "external" };
  });
  if (wasHot) stats.hot += 1;
  else stats[loaded.tier] += 1;
  return loaded.bars;
}

async function fetchDailyArchives(env: BacktestEnv, origin: string, asset: string, market: string, timeframe: Timeframe, startTime: number, endTime: number, stats: KlineCacheStats): Promise<Bar[]> {
  const dayMs = 24 * 60 * 60 * 1000;
  const firstDay = Math.floor(startTime / dayMs) * dayMs;
  const requests: Promise<Bar[] | null>[] = [];
  for (let day = firstDay; day <= endTime; day += dayMs) {
    requests.push(loadArchiveSegment(env, origin, asset, market, timeframe, "daily", day, stats));
  }
  return (await Promise.all(requests)).flatMap((rows) => rows ?? []).filter((bar) => bar.timestamp >= startTime && bar.timestamp <= endTime);
}

async function fetchBinanceArchiveBars(env: BacktestEnv, origin: string, asset: string, market: string, timeframe: Timeframe, startTime: number, endTime: number, stats: KlineCacheStats): Promise<Bar[]> {
  if (!/^[A-Z0-9]{5,20}$/.test(asset)) throw new Error("交易标的格式无效");
  const monthRequests: Promise<Bar[]>[] = [];
  for (let month = utcMonthStart(startTime); month <= utcMonthStart(endTime); month = nextUtcMonth(month)) {
    const rangeStart = Math.max(startTime, month);
    const rangeEnd = Math.min(endTime, nextUtcMonth(month) - 1);
    monthRequests.push((async () => {
      const monthly = await loadArchiveSegment(env, origin, asset, market, timeframe, "monthly", month, stats);
      if (!monthly || monthly.length === 0) return fetchDailyArchives(env, origin, asset, market, timeframe, rangeStart, rangeEnd, stats);
      const rows = monthly.filter((bar) => bar.timestamp >= rangeStart && bar.timestamp <= rangeEnd);
      const missing: Promise<Bar[]>[] = [];
      const first = rows[0]?.timestamp ?? monthly[0]!.timestamp;
      const last = rows.at(-1)?.timestamp ?? monthly.at(-1)!.timestamp;
      if (first > rangeStart) missing.push(fetchDailyArchives(env, origin, asset, market, timeframe, rangeStart, first - 1, stats));
      if (last + TIMEFRAME_MS[timeframe] <= rangeEnd) {
        missing.push(fetchDailyArchives(env, origin, asset, market, timeframe, last + TIMEFRAME_MS[timeframe], rangeEnd, stats));
      }
      return [...rows, ...(await Promise.all(missing)).flat()];
    })());
  }
  return finishBars((await Promise.all(monthRequests)).flat(), timeframe, endTime);
}

async function fetchBinanceBars(env: BacktestEnv, origin: string, asset: string, market: string, timeframe: Timeframe, startTime: number, endTime: number): Promise<FetchedBars> {
  const cache: KlineCacheStats = { hot: 0, local: 0, object: 0, external: 0 };
  try {
    const bars = await fetchBinanceArchiveBars(env, origin, asset, market, timeframe, startTime, endTime, cache);
    const localOnly = cache.external === 0;
    const warnings = bars.at(-1)!.timestamp + TIMEFRAME_MS[timeframe] < endTime
      ? [`本地历史库尚未覆盖所选结束时间，结果截至 ${new Date(bars.at(-1)!.timestamp + TIMEFRAME_MS[timeframe] - 1).toISOString()}`]
      : [];
    return {
      bars,
      dataSource: localOnly ? "ProofTrade 本地历史库 · Binance 原始K线" : "Binance 官方历史归档 · 已写入 ProofTrade 本地缓存",
      warnings,
      cache,
    };
  } catch (archiveError) {
    console.warn("Local and archived klines unavailable; trying Binance REST", archiveError);
    try {
      return {
        bars: await fetchBinanceRestBars(asset, market, timeframe, startTime, endTime),
        dataSource: market === "Binance Spot" ? "Binance Spot 官方公开行情 API（本地冷启动失败）" : "Binance USDⓈ-M 官方公开行情 API（本地冷启动失败）",
        warnings: ["本次使用外部行情兜底；历史归档将在下一次请求时继续尝试本地化。"],
        cache: { ...cache, external: cache.external + 1 },
      };
    } catch (restError) {
      console.error("Binance REST fallback unavailable", restError);
      throw new Error("ProofTrade 本地历史库与 Binance 冷启动源当前均不可用，请稍后重试");
    }
  }
}

function aggregateBars(source: Bar[], sourceTimeframe: Timeframe, targetTimeframe: Timeframe): Bar[] {
  const sourceMs = TIMEFRAME_MS[sourceTimeframe];
  const targetMs = TIMEFRAME_MS[targetTimeframe];
  if (targetMs < sourceMs || targetMs % sourceMs !== 0) throw new Error(`不能从 ${sourceTimeframe} 数据构造 ${targetTimeframe} 周期`);
  if (targetMs === sourceMs) return source;
  const expected = targetMs / sourceMs;
  const groups = new Map<number, Bar[]>();
  for (const bar of source) {
    const bucket = Math.floor(bar.timestamp / targetMs) * targetMs;
    const rows = groups.get(bucket) ?? [];
    rows.push(bar);
    groups.set(bucket, rows);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).flatMap(([timestamp, rows]) => {
    if (rows.length !== expected) return [];
    return [{
      timestamp,
      open: rows[0]!.open,
      high: Math.max(...rows.map((bar) => bar.high)),
      low: Math.min(...rows.map((bar) => bar.low)),
      close: rows.at(-1)!.close,
      volume: rows.reduce((sum, bar) => sum + bar.volume, 0),
    }];
  });
}

function referencedTimeframes(contract: StrategyContract): Timeframe[] {
  const found = new Set<Timeframe>([contract.timeframe]);
  for (const rule of contract.rules) {
    for (const condition of rule.when) {
      for (const match of condition.matchAll(/timeframe\("(1m|15m|1h|4h)"\)/g)) found.add(match[1] as Timeframe);
      if (/market\.(fundingRate|openInterest)/.test(condition)) throw new CodedError("OHLCV_ONLY");
    }
  }
  return [...found];
}

class IndicatorEngine {
  private readonly cache = new Map<string, Array<number | null>>();

  constructor(
    private readonly series: Record<string, Bar[]>,
    private readonly primaryTimeframe: Timeframe,
    private readonly primaryBars: Bar[],
  ) {}

  private cursor(timeframe: Timeframe, primaryIndex: number): number {
    if (timeframe === this.primaryTimeframe) return primaryIndex;
    const rows = this.series[timeframe] ?? [];
    const decisionTime = this.primaryBars[primaryIndex]!.timestamp + TIMEFRAME_MS[this.primaryTimeframe];
    let low = 0;
    let high = rows.length - 1;
    let answer = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const row = rows[middle]!;
      if (row.timestamp + TIMEFRAME_MS[timeframe] <= decisionTime) {
        answer = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    return answer;
  }

  private values(timeframe: Timeframe, field: keyof Pick<Bar, "open" | "high" | "low" | "close" | "volume">): number[] {
    return (this.series[timeframe] ?? []).map((bar) => bar[field]);
  }

  private simpleMovingAverage(values: number[], period: number): Array<number | null> {
    const output: Array<number | null> = Array(values.length).fill(null);
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) {
      sum += values[index]!;
      if (index >= period) sum -= values[index - period]!;
      if (index >= period - 1) output[index] = sum / period;
    }
    return output;
  }

  private exponentialMovingAverage(values: Array<number | null>, period: number): Array<number | null> {
    const output: Array<number | null> = Array(values.length).fill(null);
    const alpha = 2 / (period + 1);
    const seed: number[] = [];
    let previous: number | null = null;
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value === null || value === undefined) continue;
      if (previous === null) {
        seed.push(value);
        if (seed.length === period) {
          previous = seed.reduce((sum, item) => sum + item, 0) / period;
          output[index] = previous;
        }
      } else {
        previous = value * alpha + previous * (1 - alpha);
        output[index] = previous;
      }
    }
    return output;
  }

  private compute(timeframe: Timeframe, name: string, args: string[]): Array<number | null> {
    const key = `${timeframe}:${name}:${args.join(":")}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const rows = this.series[timeframe] ?? [];
    let output: Array<number | null>;
    if (["sma", "ema", "rsi", "highest", "lowest", "percentChange"].includes(name)) {
      const field = args[0] as keyof Pick<Bar, "open" | "high" | "low" | "close" | "volume">;
      if (!MARKET_FIELDS.has(field)) throw new Error(`不支持的行情字段 ${field}`);
      const period = Number(args[1]);
      if (!Number.isInteger(period) || period < 1 || period > 1000) throw new Error(`指标周期 ${args[1]} 无效`);
      const values = this.values(timeframe, field);
      if (name === "sma") output = this.simpleMovingAverage(values, period);
      else if (name === "ema") output = this.exponentialMovingAverage(values, period);
      else if (name === "rsi") {
        output = Array(values.length).fill(null);
        let averageGain = 0;
        let averageLoss = 0;
        for (let index = 1; index < values.length; index += 1) {
          const change = values[index]! - values[index - 1]!;
          const gain = Math.max(0, change);
          const loss = Math.max(0, -change);
          if (index <= period) {
            averageGain += gain / period;
            averageLoss += loss / period;
            if (index === period) output[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
          } else {
            averageGain = (averageGain * (period - 1) + gain) / period;
            averageLoss = (averageLoss * (period - 1) + loss) / period;
            output[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
          }
        }
      } else if (name === "percentChange") {
        output = values.map((value, index) => index >= period && values[index - period] !== 0 ? value / values[index - period]! - 1 : null);
      } else {
        output = values.map((_, index) => {
          if (index < period - 1) return null;
          const window = values.slice(index - period + 1, index + 1);
          return name === "highest" ? Math.max(...window) : Math.min(...window);
        });
      }
    } else if (name === "atr") {
      const period = Number(args[0]);
      const trueRanges = rows.map((bar, index) => index === 0 ? bar.high - bar.low : Math.max(bar.high - bar.low, Math.abs(bar.high - rows[index - 1]!.close), Math.abs(bar.low - rows[index - 1]!.close)));
      output = Array(rows.length).fill(null);
      let previous: number | null = null;
      for (let index = period - 1; index < trueRanges.length; index += 1) {
        if (previous === null) previous = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
        else previous = (previous * (period - 1) + trueRanges[index]!) / period;
        output[index] = previous;
      }
    } else if (name.startsWith("bollinger:")) {
      const component = name.split(":")[1];
      const field = args[0] as keyof Pick<Bar, "open" | "high" | "low" | "close" | "volume">;
      const period = Number(args[1]);
      const multiplier = Number(args[2]);
      const values = this.values(timeframe, field);
      output = values.map((_, index) => {
        if (index < period - 1) return null;
        const window = values.slice(index - period + 1, index + 1);
        const mean = window.reduce((sum, value) => sum + value, 0) / period;
        const deviation = Math.sqrt(window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period);
        return component === "upper" ? mean + multiplier * deviation : component === "lower" ? mean - multiplier * deviation : mean;
      });
    } else if (name.startsWith("macd:")) {
      const component = name.split(":")[1];
      const field = args[0] as keyof Pick<Bar, "open" | "high" | "low" | "close" | "volume">;
      const fast = Number(args[1]);
      const slow = Number(args[2]);
      const signalPeriod = Number(args[3]);
      const values = this.values(timeframe, field);
      const fastLine = this.exponentialMovingAverage(values, fast);
      const slowLine = this.exponentialMovingAverage(values, slow);
      const macd = values.map((_, index) => fastLine[index] !== null && slowLine[index] !== null ? fastLine[index]! - slowLine[index]! : null);
      const signal = this.exponentialMovingAverage(macd, signalPeriod);
      output = component === "macd" ? macd : component === "signal" ? signal : macd.map((value, index) => value !== null && signal[index] !== null ? value - signal[index]! : null);
    } else throw new Error(`回测引擎暂不支持指标 ${name}`);
    this.cache.set(key, output);
    return output;
  }

  expression(raw: string, primaryIndex: number, defaultTimeframe: Timeframe): number | null {
    let value = stripOuterParentheses(compact(raw));
    const additive = findArithmeticOperator(value, new Set(["+", "-"]));
    const multiplicative = additive < 0 ? findArithmeticOperator(value, new Set(["*", "/"])) : -1;
    const operatorIndex = additive >= 0 ? additive : multiplicative;
    if (operatorIndex >= 0) {
      const left = this.expression(value.slice(0, operatorIndex), primaryIndex, defaultTimeframe);
      const right = this.expression(value.slice(operatorIndex + 1), primaryIndex, defaultTimeframe);
      if (left === null || right === null) return null;
      const operator = value[operatorIndex];
      if (operator === "+") return left + right;
      if (operator === "-") return left - right;
      if (operator === "*") return left * right;
      if (right === 0) throw new Error(`条件表达式不能除以零：${raw}`);
      return left / right;
    }
    if (value.startsWith("-") && value.length > 1) {
      const operand = this.expression(value.slice(1), primaryIndex, defaultTimeframe);
      return operand === null ? null : -operand;
    }
    let timeframe = defaultTimeframe;
    const prefix = /^timeframe\("(1m|15m|1h|4h)"\)\.(.+)$/.exec(value);
    if (prefix) {
      timeframe = prefix[1] as Timeframe;
      value = prefix[2]!;
    }
    const numeric = Number(value);
    if (value !== "" && Number.isFinite(numeric)) return numeric;
    const market = /^market\.(open|high|low|close|volume)$/.exec(value);
    const cursor = this.cursor(timeframe, primaryIndex);
    if (market) return cursor >= 0 ? this.series[timeframe]?.[cursor]?.[market[1] as "open" | "high" | "low" | "close" | "volume"] ?? null : null;
    const basic = /^(sma|ema|rsi|highest|lowest)\("(open|high|low|close|volume)",(\d+),(\d+)\)$/.exec(value);
    if (basic) {
      const output = this.compute(timeframe, basic[1]!, [basic[2]!, basic[3]!]);
      return output[cursor - Number(basic[4])] ?? null;
    }
    const percentChange = /^percentChange\("(open|high|low|close|volume)",(\d+)(?:,(\d+))?\)$/.exec(value);
    if (percentChange) {
      const output = this.compute(timeframe, "percentChange", [percentChange[1]!, percentChange[2]!]);
      return output[cursor - Number(percentChange[3] ?? 0)] ?? null;
    }
    const atr = /^atr\((\d+),(\d+)\)$/.exec(value);
    if (atr) return this.compute(timeframe, "atr", [atr[1]!])[cursor - Number(atr[2])] ?? null;
    const bollinger = /^bollingerBands\("(open|high|low|close|volume)",(\d+),([\d.]+),(\d+)\)\.(upper|middle|lower)$/.exec(value);
    if (bollinger) return this.compute(timeframe, `bollinger:${bollinger[5]}`, [bollinger[1]!, bollinger[2]!, bollinger[3]!])[cursor - Number(bollinger[4])] ?? null;
    const macd = /^macd\("(open|high|low|close|volume)",(\d+),(\d+),(\d+),(\d+)\)\.(macd|signal|histogram)$/.exec(value);
    if (macd) return this.compute(timeframe, `macd:${macd[6]}`, [macd[1]!, macd[2]!, macd[3]!, macd[4]!])[cursor - Number(macd[5])] ?? null;
    throw new Error(`回测无法解释条件表达式：${raw}`);
  }
}

function compare(left: number, operator: string, right: number): boolean {
  if (operator === ">") return left > right;
  if (operator === ">=") return left >= right;
  if (operator === "<") return left < right;
  if (operator === "<=") return left <= right;
  return left === right;
}

function conditionMatches(condition: string, index: number, positionSide: PositionSide, timeframe: Timeframe, indicators: IndicatorEngine): boolean {
  const value = compact(condition);
  const position = /^position\.side=="(flat|long|short)"$/.exec(value);
  if (position) return positionSide === position[1];
  const cross = /^(crossAbove|crossBelow)\((.*)\)$/.exec(value);
  if (cross) {
    const args = splitArguments(cross[2]!);
    if (args.length !== 4) throw new Error(`交叉条件必须包含四个值：${condition}`);
    const values = args.map((argument) => indicators.expression(argument, index, timeframe));
    if (values.some((item) => item === null)) return false;
    const [currentLeft, previousLeft, currentRight, previousRight] = values as number[];
    return cross[1] === "crossAbove"
      ? previousLeft <= previousRight && currentLeft > currentRight
      : previousLeft >= previousRight && currentLeft < currentRight;
  }
  const relational = findComparison(value);
  if (!relational) throw new Error(`回测无法解释策略条件：${condition}`);
  const left = indicators.expression(relational.left, index, timeframe);
  const right = indicators.expression(relational.right, index, timeframe);
  return left !== null && right !== null && compare(left, relational.operator, right);
}

function calculateMetrics(initialCapital: number, finalEquity: number, equityCurve: EquityPoint[], trades: ClosedTrade[], bars: Bar[]) {
  let peak = initialCapital;
  let maximumDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    maximumDrawdown = Math.min(maximumDrawdown, peak > 0 ? point.equity / peak - 1 : 0);
  }
  const returns = equityCurve.slice(1).flatMap((point, index) => {
    const previous = equityCurve[index]?.equity;
    return previous && previous > 0 ? [point.equity / previous - 1] : [];
  });
  const mean = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
  const variance = returns.length > 1 ? returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1) : 0;
  const intervalMs = bars.length > 1 ? (bars.at(-1)!.timestamp - bars[0]!.timestamp) / (bars.length - 1) : 365.25 * 24 * 60 * 60 * 1000;
  const sharpe = variance > 0 ? mean / Math.sqrt(variance) * Math.sqrt(365.25 * 24 * 60 * 60 * 1000 / Math.max(1, intervalMs)) : null;
  const winners = trades.filter((trade) => trade.netPnl > 0);
  const losers = trades.filter((trade) => trade.netPnl < 0);
  const grossProfit = winners.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + trade.netPnl, 0));
  return {
    netReturn: finalEquity / initialCapital - 1,
    maximumDrawdown,
    sharpe,
    winRate: trades.length ? winners.length / trades.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    tradeCount: trades.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
    fees: trades.reduce((sum, trade) => sum + trade.fees, 0),
    slippageCost: trades.reduce((sum, trade) => sum + trade.slippageCost, 0),
    buyAndHoldReturn: bars.at(-1)!.close / bars[0]!.close - 1,
  };
}

export function runContractBacktest(contract: StrategyContract, bars: Bar[], config: BacktestConfig, options: { evaluationStartTime?: number } = {}) {
  const timeframes = referencedTimeframes(contract);
  const series = Object.fromEntries(timeframes.map((timeframe) => [timeframe, aggregateBars(bars, contract.timeframe, timeframe)]));
  const indicators = new IndicatorEngine(series, contract.timeframe, bars);
  let cash = config.initialCapital;
  let position: OpenPosition | null = null;
  let pending: ContractDecision | null = null;
  const trades: ClosedTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const evaluationStartTime = options.evaluationStartTime ?? bars[0]!.timestamp;
  const evaluationBars = bars.filter((bar) => bar.timestamp >= evaluationStartTime);
  if (evaluationBars.length < 2) throw new Error("绩效窗口没有足够的完整K线");
  const withSlippage = (price: number, side: "buy" | "sell") => price * (1 + (side === "buy" ? 1 : -1) * config.slippageBps / 10_000);
  const closePosition = (bar: Bar, rawPrice: number, reason: string) => {
    if (!position) return;
    const exitPrice = withSlippage(rawPrice, position.side === "long" ? "sell" : "buy");
    const direction = position.side === "long" ? 1 : -1;
    const grossPnl = direction * (exitPrice - position.entryPrice) * position.quantity;
    const exitFee = exitPrice * position.quantity * config.takerFeeRate;
    const exitSlippageCost = Math.abs(exitPrice - rawPrice) * position.quantity;
    cash += grossPnl - exitFee;
    trades.push({
      side: position.side,
      entryTimestamp: position.entryTimestamp,
      exitTimestamp: bar.timestamp,
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.quantity,
      grossPnl,
      fees: position.entryFee + exitFee,
      slippageCost: position.entrySlippageCost + exitSlippageCost,
      netPnl: grossPnl - position.entryFee - exitFee,
      exitReason: reason,
    });
    position = null;
  };

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    if (bar.timestamp < evaluationStartTime) {
      pending = null;
      continue;
    }
    if (pending?.type === "open" && !position) {
      if (!pending.side || !pending.sizeKind || !pending.sizeValue || !pending.stopLossPercent) throw new Error("开仓规则缺少方向、仓位或止损");
      const decision: ContractDecision = pending;
      const entryPrice = withSlippage(bar.open, decision.side === "long" ? "buy" : "sell");
      const requestedNotional: number = decision.sizeKind === "fixedNotional"
        ? decision.sizeValue!
        : decision.sizeKind === "equityPercent"
          ? cash * decision.sizeValue!
          : cash * decision.sizeValue! / decision.stopLossPercent!;
      const quantity: number = Math.min(requestedNotional, cash * config.maxLeverage) / entryPrice;
      const entryFee = entryPrice * quantity * config.takerFeeRate;
      cash -= entryFee;
      const direction = decision.side === "long" ? 1 : -1;
      const stopDistance = entryPrice * decision.stopLossPercent!;
      position = {
        side: decision.side!,
        quantity,
        entryTimestamp: bar.timestamp,
        entryPrice,
        entryFee,
        entrySlippageCost: Math.abs(entryPrice - bar.open) * quantity,
        stopPrice: entryPrice - direction * stopDistance,
        takeProfitPrice: decision.takeProfitRiskReward ? entryPrice + direction * stopDistance * decision.takeProfitRiskReward : null,
      };
    } else if (pending?.type === "close" && position) closePosition(bar, bar.open, "strategy");
    pending = null;

    if (position) {
      const stopHit = position.side === "long" ? bar.low <= position.stopPrice : bar.high >= position.stopPrice;
      const takeHit = position.takeProfitPrice !== null && (position.side === "long" ? bar.high >= position.takeProfitPrice : bar.low <= position.takeProfitPrice);
      if (stopHit) closePosition(bar, position.stopPrice, "stopLoss");
      else if (takeHit && position?.takeProfitPrice !== null) closePosition(bar, position.takeProfitPrice, "takeProfit");
    }

    const unrealized = position ? (position.side === "long" ? 1 : -1) * (bar.close - position.entryPrice) * position.quantity : 0;
    equityCurve.push({ timestamp: bar.timestamp, equity: cash + unrealized });
    const side: PositionSide = position?.side ?? "flat";
    const matched: ContractRule | undefined = contract.rules.find((rule): boolean =>
      rule.when.every((condition): boolean => conditionMatches(condition, index, side, contract.timeframe, indicators))
    );
    pending = matched?.decision ?? null;
  }
  const lastBar = bars.at(-1)!;
  if (position) {
    closePosition(lastBar, lastBar.close, "endOfData");
    equityCurve.at(-1)!.equity = cash;
  }
  return {
    initialCapital: config.initialCapital,
    finalEquity: cash,
    metrics: calculateMetrics(config.initialCapital, cash, equityCurve, trades, evaluationBars),
    trades,
    equityCurve,
  };
}

type BacktestCoreResult = ReturnType<typeof runContractBacktest>;

/**
 * Data fields the Web kline pipeline cannot transport today. A program that
 * gates on any of them must be intercepted before the service is asked to run
 * it: the service would happily compute funding as zero and return a wrong,
 * silently plausible result. Phase 2's verify gate catches these at analyze
 * time; this is the safety net for legacy rows on the proxied path.
 */
const SERVICE_UNSUPPORTED_FIELDS = /\b(markPrice|fundingRate|openInterest|quoteVolume|takerBuyBaseVolume|takerBuyQuoteVolume)\b/;

/** Throws the historical OHLCV_ONLY code when the program needs data the Web lacks. */
function assertServiceSupported(source: string): void {
  if (SERVICE_UNSUPPORTED_FIELDS.test(source)) throw new CodedError("OHLCV_ONLY");
}

/**
 * The higher timeframes a program can read, mirroring `referencedTimeframes`
 * but without its OHLCV_ONLY guard: the service engine supports funding/OI, so
 * only the caller's data limitations matter here.
 */
function serviceTimeframeContext(contract: StrategyContract, bars: Bar[]): { primaryTimeframe: Timeframe; bars: Partial<Record<Timeframe, Bar[]>> } | undefined {
  const found = new Set<Timeframe>([contract.timeframe]);
  for (const rule of contract.rules) {
    for (const condition of rule.when) {
      for (const match of condition.matchAll(/timeframe\("(1m|15m|1h|4h)"\)/g)) found.add(match[1] as Timeframe);
    }
  }
  const higher = [...found].filter((timeframe) => timeframe !== contract.timeframe);
  if (higher.length === 0) return undefined;
  return {
    primaryTimeframe: contract.timeframe,
    bars: Object.fromEntries(higher.map((timeframe) => [timeframe, aggregateBars(bars, contract.timeframe, timeframe)])),
  };
}

/** Runs the real program on the Node service and maps the result to the Web shape. */
async function runBacktestOnService(
  env: BacktestEnv,
  source: string,
  bars: Bar[],
  config: BacktestConfig,
  timeframeContext: { primaryTimeframe: Timeframe; bars: Partial<Record<Timeframe, Bar[]>> } | undefined,
): Promise<BacktestCoreResult> {
  const baseUrl = env.BACKTEST_SERVICE_URL!.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/v1/backtest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "backtest-1.0",
      source,
      bars,
      config: {
        initialCapital: config.initialCapital,
        takerFeeRate: config.takerFeeRate,
        slippageBps: config.slippageBps,
        maxLeverage: config.maxLeverage,
      },
      ...(timeframeContext ? { timeframeContext } : {}),
    }),
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = typeof payload?.code === "string" ? payload.code : "BACKTEST_SERVICE_ERROR";
    const message = typeof payload?.message === "string" ? payload.message : "回测服务执行失败";
    throw new CodedError(code, { message });
  }
  if (!payload || typeof payload.metrics !== "object" || !Array.isArray(payload.trades) || !Array.isArray(payload.equityCurve)) {
    throw new CodedError("BACKTEST_SERVICE_ERROR", { message: "回测服务返回格式无效" });
  }
  const buyAndHoldReturn = bars.length > 1 ? bars.at(-1)!.close / bars[0]!.close - 1 : 0;
  return {
    initialCapital: config.initialCapital,
    finalEquity: payload.finalEquity as number,
    metrics: { ...(payload.metrics as Record<string, unknown>), buyAndHoldReturn },
    trades: payload.trades as ClosedTrade[],
    equityCurve: payload.equityCurve as EquityPoint[],
  } as unknown as BacktestCoreResult;
}

/**
 * Shadow comparison: the legacy contract interpreter runs the same bars and the
 * two engines are checked for divergence. A mismatch is logged with enough
 * detail to find the strategy; it never rolls back the UI result.
 */
function shadowCompare(legacy: BacktestCoreResult, service: BacktestCoreResult, bars: Bar[], strategyId: string): void {
  const divergent =
    legacy.metrics.tradeCount !== service.metrics.tradeCount
    || Math.abs(legacy.finalEquity - service.finalEquity) / Math.max(1, Math.abs(legacy.finalEquity)) > 0.001
    || Math.abs(legacy.metrics.netReturn - service.metrics.netReturn) > 0.0005;
  if (!divergent) return;
  console.warn("[shadow] backtest divergence", JSON.stringify({
    strategyId,
    bars: bars.length,
    legacy: { tradeCount: legacy.metrics.tradeCount, finalEquity: legacy.finalEquity, netReturn: legacy.metrics.netReturn },
    service: { tradeCount: service.metrics.tradeCount, finalEquity: service.finalEquity, netReturn: service.metrics.netReturn },
  }));
}

function engineConfig(config: BacktestConfig) {
  return {
    initialCapital: config.initialCapital,
    takerFeeRate: config.takerFeeRate,
    slippageBps: config.slippageBps,
    maxLeverage: config.maxLeverage,
  };
}

/** Runs the parameter lab on the Node service; the service does pure computation only. */
async function runOptimizationOnService(
  env: BacktestEnv,
  input: {
    source: string;
    contract: StrategyContract;
    selections: ParameterSelection[];
    objective: OptimizationCoreResult["objective"];
    maximumTrials: number;
    bars: Bar[];
    config: BacktestConfig;
  },
): Promise<OptimizationCoreResult> {
  const baseUrl = env.BACKTEST_SERVICE_URL!.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/v1/optimization/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "optimization-1.0",
      source: input.source,
      contract: input.contract,
      selections: input.selections,
      objective: input.objective,
      maximumTrials: input.maximumTrials,
      bars: input.bars,
      config: engineConfig(input.config),
    }),
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = typeof payload?.code === "string" ? payload.code : "OPTIMIZATION_SERVICE_ERROR";
    throw new CodedError(code, { message: typeof payload?.message === "string" ? payload.message : "优化服务执行失败" });
  }
  if (!payload || typeof payload.result !== "object") {
    throw new CodedError("OPTIMIZATION_SERVICE_ERROR", { message: "优化服务返回格式无效" });
  }
  return payload.result as OptimizationCoreResult;
}

/** Runs the one-shot final blind test on the Node service. */
async function runBlindOnService(
  env: BacktestEnv,
  input: {
    source: string;
    contract: StrategyContract;
    candidateParameters: Record<string, number>;
    bars: Bar[];
    config: BacktestConfig;
    blindStartTime: number;
  },
): Promise<{ passed: boolean; baseline: OptimizationMetrics; candidate: OptimizationMetrics; checks: Array<{ id: string; label: string; passed: boolean; detail: string }> }> {
  const baseUrl = env.BACKTEST_SERVICE_URL!.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/v1/optimization/blind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "blind-1.0",
      source: input.source,
      contract: input.contract,
      candidateParameters: input.candidateParameters,
      bars: input.bars,
      config: engineConfig(input.config),
      blindStartTime: input.blindStartTime,
    }),
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = typeof payload?.code === "string" ? payload.code : "BLIND_SERVICE_ERROR";
    throw new CodedError(code, { message: typeof payload?.message === "string" ? payload.message : "盲测服务执行失败" });
  }
  if (!payload || typeof payload.outcome !== "object") {
    throw new CodedError("BLIND_SERVICE_ERROR", { message: "盲测服务返回格式无效" });
  }
  return payload.outcome as { passed: boolean; baseline: OptimizationMetrics; candidate: OptimizationMetrics; checks: Array<{ id: string; label: string; passed: boolean; detail: string }> };
}

/** Materializes the parameter version's real program on the Node service. */
async function materializeSourceOnService(
  env: BacktestEnv,
  source: string,
  contract: StrategyContract,
  parameters: Record<string, number>,
): Promise<string> {
  const baseUrl = env.BACKTEST_SERVICE_URL!.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/v1/optimization/materialize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "materialize-1.0",
      source,
      contract,
      parameters,
    }),
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = typeof payload?.code === "string" ? payload.code : "MATERIALIZE_SERVICE_ERROR";
    throw new CodedError(code, { message: typeof payload?.message === "string" ? payload.message : "参数程序物化失败" });
  }
  if (!payload || typeof payload.source !== "string") {
    throw new CodedError("MATERIALIZE_SERVICE_ERROR", { message: "物化服务返回格式无效" });
  }
  return payload.source;
}

const HOT_BACKTEST_RESULTS = new HotPromiseCache<{ result: BacktestCoreResult; tier: "object" | "computed" }>(16);
const HOT_OPTIMIZATION_RESULTS = new HotPromiseCache<{ result: OptimizationCoreResult; tier: "object" | "computed" }>(8);

async function runBacktest(request: Request, env: BacktestEnv, identity: Identity): Promise<Response> {
  const body = await request.json() as Record<string, unknown>;
  const strategyId = cleanString(body.strategyId, 96);
  if (!strategyId) return fail("BAD_REQUEST", 400);
  if (!identity.user) return fail("AUTH_REQUIRED", 401);
  await ensureBacktestSchema(env.DB);
  const recent = await env.DB.prepare("SELECT COUNT(*) AS count FROM backtest_runs WHERE user_id = ? AND created_at > ?")
    .bind(identity.user.id, new Date(Date.now() - 60 * 60 * 1000).toISOString()).first<{ count: number }>();
  if ((recent?.count ?? 0) >= 10) return fail("RATE_LIMITED", 429, undefined, 600);
  const stored = await ownedStrategy(env.DB, identity, strategyId);
  if (!stored) return fail("NOT_FOUND", 404);
  if (!stored.confirmed_at) return fail("NOT_CONFIRMED", 409);
  // The workspace id comes from the stored row, never from the request body, so a
  // caller cannot address another visitor's records by guessing an id.
  const sessionId = stored.session_id;
  const strategy = JSON.parse(stored.result_json) as Record<string, unknown>;
  if (strategy.status !== "ready") return fail("NOT_RUNNABLE", 409);
  const contract = validateContract(strategy.contract);
  const parameterSchema = extractParameterSchema(contract).map(publicParameter);
  const semanticLockHash = await sha256Text(semanticSkeleton(contract));
  const usingService = Boolean(env.BACKTEST_SERVICE_URL);
  const source = typeof strategy.source === "string" ? strategy.source : "";
  // The service executes the real program; for that path the program must not
  // depend on data fields the Web kline pipeline cannot feed it. The AST-based
  // verify gate catches these at analyze time; this regex is the legacy-row
  // safety net. When there is no stored source (very old rows) the Web falls
  // back to the contract interpreter rather than refusing to run.
  if (usingService && source === "") return fail("SOURCE_MISSING", 422);
  if (usingService) assertServiceSupported(source);
  const now = Date.now();
  const requestedEnd = Math.min(now - TIMEFRAME_MS[contract.timeframe], finite(body.endTime, now - TIMEFRAME_MS[contract.timeframe], 1_500_000_000_000, now));
  const defaultWindow = contract.timeframe === "1m" ? 3 * 24 * 60 * 60 * 1000 : contract.timeframe === "15m" ? 60 * 24 * 60 * 60 * 1000 : 365 * 24 * 60 * 60 * 1000;
  const requestedStart = finite(body.startTime, requestedEnd - defaultWindow, 1_500_000_000_000, requestedEnd - TIMEFRAME_MS[contract.timeframe]);
  const { startTime, endTime } = alignWindow(requestedStart, requestedEnd, contract.timeframe);
  if ((endTime - startTime) / TIMEFRAME_MS[contract.timeframe] > MAX_BARS) return fail("RANGE_TOO_LARGE", 400, { timeframe: contract.timeframe, maxBars: MAX_BARS.toLocaleString("en-US") });
  const config: BacktestConfig = {
    initialCapital: finite(body.initialCapital, 10_000, 100, 100_000_000),
    takerFeeRate: finite(body.takerFeeRate, 0.00045, 0, 0.01),
    slippageBps: finite(body.slippageBps, 2, 0, 100),
    maxLeverage: finite(body.maxLeverage, 3, 1, 20),
    startTime,
    endTime,
  };
  const started = Date.now();
  const dataStarted = Date.now();
  const fetched = await fetchBinanceBars(env, request.url, stored.asset, stored.market, contract.timeframe, startTime, endTime);
  const bars = fetched.bars;
  const dataMs = Date.now() - dataStarted;
  const barsDigest = await sha256Text(JSON.stringify(compactBars(bars)));
  const engine = usingService ? "cli-sandbox-service" : "proof-worker-contract";
  const resultCacheKey = await sha256Text(JSON.stringify({
    version: BACKTEST_CACHE_VERSION,
    engine,
    contract,
    asset: stored.asset,
    market: stored.market,
    timeframe: contract.timeframe,
    startTime,
    endTime,
    initialCapital: config.initialCapital,
    takerFeeRate: config.takerFeeRate,
    slippageBps: config.slippageBps,
    maxLeverage: config.maxLeverage,
    barsDigest,
  }));
  const resultObjectKey = `${BACKTEST_CACHE_VERSION}/results/${resultCacheKey}.json.gz`;
  const wasHotResult = HOT_BACKTEST_RESULTS.has(resultObjectKey);
  const executionStarted = Date.now();
  const cachedResult = await HOT_BACKTEST_RESULTS.getOrLoad(resultObjectKey, async () => {
    const objectResult = await readObjectJson<BacktestCoreResult>(env.CACHE, resultObjectKey);
    if (objectResult) return { result: objectResult, tier: "object" as const };
    const computed = usingService
      ? await runBacktestOnService(env, source, bars, config, serviceTimeframeContext(contract, bars))
      : runContractBacktest(contract, bars, config);
    await writeObjectJson(env.CACHE, resultObjectKey, computed);
    return { result: computed, tier: "computed" as const };
  });
  const result = cachedResult.result;
  // Shadow mode: run the legacy interpreter on the same bars and log any
  // divergence beyond tolerance. The service result is always the one returned.
  if (usingService && env.BACKTEST_SHADOW_MODE === "true") {
    try {
      shadowCompare(runContractBacktest(contract, bars, config), result, bars, strategyId);
    } catch (error) {
      console.warn("[shadow] legacy interpreter failed", error);
    }
  }
  const executionMs = Date.now() - executionStarted;
  const resultCache = wasHotResult ? "memory-hit" : cachedResult.tier === "object" ? "persistent-hit" : "miss";
  const id = crypto.randomUUID();
  const response = {
    id,
    strategyId,
    strategyName: strategy.strategyName ?? "已确认策略",
    asset: stored.asset,
    market: stored.market,
    timeframe: contract.timeframe,
    dataSource: fetched.dataSource,
    dataWarnings: fetched.warnings,
    engineVersion: usingService ? SERVICE_ENGINE_VERSION : "proof-worker-0.4.0",
    executionModel: "closed-bar signal → next-bar open; stop-loss wins same-bar conflicts",
    startedAt: new Date(bars[0]!.timestamp).toISOString(),
    endedAt: new Date(bars.at(-1)!.timestamp + TIMEFRAME_MS[contract.timeframe] - 1).toISOString(),
    durationMs: Date.now() - started,
    performance: { dataMs, executionMs, klineCache: fetched.cache, resultCache, load: BACKTEST_GATE.load },
    optimization: {
      schemaVersion: "parameters-1.0",
      semanticLockHash,
      lockedSemantics: ["交易周期", "开平仓动作", "多空方向", "指标与行情字段", "比较符和布尔结构", "成交时序"],
      parameters: parameterSchema,
    },
    barCount: bars.length,
    config: { initialCapital: config.initialCapital, takerFeeRate: config.takerFeeRate, slippageBps: config.slippageBps, maxLeverage: config.maxLeverage },
    ...result,
    // Series travel as numeric rows rather than objects; `series` names the
    // columns so the shape stays self-describing. `equityCurvePoints` is the
    // count before decimation, so the payload admits what it dropped.
    series: { bars: ["timestamp", "open", "high", "low", "close"], equityCurve: ["timestamp", "equity"] },
    equityCurve: wireEquityCurve(result.equityCurve),
    equityCurvePoints: result.equityCurve.length,
    bars: wireBars(bars),
  };
  // The row keeps everything except the two series: they are reproducible from
  // the cached result and would otherwise dominate the stored JSON.
  const storedResult = { ...response, bars: undefined, equityCurve: undefined, series: undefined };
  await env.DB.prepare(`INSERT INTO backtest_runs
    (id, strategy_submission_id, user_id, session_id, created_at, asset, market, timeframe, start_time, end_time, initial_capital, bar_count, trade_count, result_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, strategyId, identity.user.id, sessionId, new Date().toISOString(), stored.asset, stored.market, contract.timeframe, response.startedAt, response.endedAt, config.initialCapital, bars.length, result.trades.length, JSON.stringify(storedResult)).run();
  return json(response);
}

function compactOptimizationMetrics(result: BacktestCoreResult): OptimizationMetrics {
  return {
    netReturn: result.metrics.netReturn,
    maximumDrawdown: result.metrics.maximumDrawdown,
    sharpe: result.metrics.sharpe,
    winRate: result.metrics.winRate,
    profitFactor: result.metrics.profitFactor,
    tradeCount: result.metrics.tradeCount,
  };
}

function optimizationScore(train: OptimizationMetrics, validation: OptimizationMetrics, objective: OptimizationCoreResult["objective"]): number {
  const gap = Math.abs(train.netReturn - validation.netReturn);
  const lowTradePenalty = Math.max(0, 3 - validation.tradeCount) * 0.08;
  const sharpe = Math.max(-5, Math.min(5, validation.sharpe ?? 0));
  if (objective === "return") return validation.netReturn + validation.maximumDrawdown * 0.25 - gap * 0.35 - lowTradePenalty;
  if (objective === "drawdown") return validation.netReturn * 0.5 + validation.maximumDrawdown * 1.5 + sharpe * 0.03 - gap * 0.3 - lowTradePenalty;
  return validation.netReturn * 1.6 + train.netReturn * 0.2 + validation.maximumDrawdown * 0.9
    + sharpe * 0.04 + (validation.winRate ?? 0) * 0.03 - gap * 0.6 - lowTradePenalty;
}

function runEvaluationWindow(contract: StrategyContract, bars: Bar[], evaluationStartIndex: number, endIndex: number, config: BacktestConfig): BacktestCoreResult {
  const boundedStart = Math.max(0, Math.min(evaluationStartIndex, bars.length - 2));
  const boundedEnd = Math.max(boundedStart + 2, Math.min(endIndex, bars.length));
  return runContractBacktest(contract, bars.slice(0, boundedEnd), config, { evaluationStartTime: bars[boundedStart]!.timestamp });
}

function walkForwardEvidence(
  baselineContract: StrategyContract,
  candidateContract: StrategyContract,
  developmentBars: Bar[],
  config: BacktestConfig,
): RobustnessGate["walkForward"] {
  const initialTrain = Math.max(6, Math.floor(developmentBars.length * 0.5));
  const remaining = developmentBars.length - initialTrain;
  const folds: WalkForwardFold[] = [];
  for (let index = 0; index < 3; index += 1) {
    const validationStart = initialTrain + Math.floor(remaining * index / 3);
    const validationEnd = initialTrain + Math.floor(remaining * (index + 1) / 3);
    if (validationEnd - validationStart < 2) continue;
    const baseline = compactOptimizationMetrics(runEvaluationWindow(baselineContract, developmentBars, validationStart, validationEnd, config));
    const candidate = compactOptimizationMetrics(runEvaluationWindow(candidateContract, developmentBars, validationStart, validationEnd, config));
    const passed = candidate.tradeCount >= 1
      && candidate.netReturn >= baseline.netReturn - 0.01
      && candidate.maximumDrawdown >= baseline.maximumDrawdown - 0.03;
    folds.push({
      id: `WF${index + 1}`,
      trainBars: validationStart,
      validationBars: validationEnd - validationStart,
      validationStart: new Date(developmentBars[validationStart]!.timestamp).toISOString(),
      validationEnd: new Date(developmentBars[validationEnd - 1]!.timestamp).toISOString(),
      baseline,
      candidate,
      passed,
    });
  }
  const positiveFolds = folds.filter((fold) => fold.passed).length;
  return { passed: folds.length === 3 && positiveFolds >= 2, positiveFolds, folds };
}

function sensitivityEvidence(
  baseContract: StrategyContract,
  candidateValues: Record<string, number>,
  definitions: ParameterDefinition[],
  selections: ParameterSelection[],
  developmentBars: Bar[],
  evaluationStartIndex: number,
  config: BacktestConfig,
  objective: OptimizationCoreResult["objective"],
): RobustnessGate["sensitivity"] {
  const candidateContract = applyParameters(baseContract, definitions, candidateValues);
  const baseMetrics = compactOptimizationMetrics(runEvaluationWindow(candidateContract, developmentBars, evaluationStartIndex, developmentBars.length, config));
  const baseScore = optimizationScore(baseMetrics, baseMetrics, objective);
  const points: SensitivityPoint[] = [];
  for (const selection of selections) {
    const definition = definitions.find((item) => item.id === selection.id)!;
    const center = candidateValues[selection.id] ?? definition.value;
    const rawStep = (selection.max - selection.min) / Math.max(1, selection.steps - 1);
    const step = definition.kind === "integer" ? Math.max(1, Math.round(rawStep)) : rawStep;
    for (const direction of ["lower", "higher"] as const) {
      const raw = direction === "lower" ? center - step : center + step;
      const bounded = Math.max(definition.hardMin, Math.min(definition.hardMax, definition.kind === "integer" ? Math.round(raw) : raw));
      if (bounded === center) continue;
      const values = { ...candidateValues, [selection.id]: bounded };
      const metrics = compactOptimizationMetrics(runEvaluationWindow(applyParameters(baseContract, definitions, values), developmentBars, evaluationStartIndex, developmentBars.length, config));
      const score = optimizationScore(metrics, metrics, objective);
      const tolerance = Math.max(0.03, Math.abs(baseScore) * 0.5);
      const retainedFraction = Math.abs(baseMetrics.netReturn) > 0.000001 ? metrics.netReturn / baseMetrics.netReturn : null;
      points.push({ parameterId: selection.id, direction, value: bounded, metrics, retainedFraction, passed: metrics.tradeCount >= 1 && score >= baseScore - tolerance });
    }
  }
  const stablePoints = points.filter((point) => point.passed).length;
  return { passed: points.length > 0 && stablePoints >= Math.ceil(points.length * 0.6), stablePoints, totalPoints: points.length, points };
}

function costStressEvidence(
  contract: StrategyContract,
  developmentBars: Bar[],
  evaluationStartIndex: number,
  config: BacktestConfig,
): RobustnessGate["costStress"] {
  const scenarios: Array<{ id: CostStressPoint["id"]; label: string; fee: number; slippage: number }> = [
    { id: "base", label: "当前成本", fee: config.takerFeeRate, slippage: config.slippageBps },
    { id: "double", label: "双倍成本", fee: Math.min(0.01, config.takerFeeRate * 2), slippage: Math.min(100, config.slippageBps * 2) },
    { id: "severe", label: "严重冲击", fee: Math.min(0.01, config.takerFeeRate * 3), slippage: Math.min(100, Math.max(config.slippageBps * 3, config.slippageBps + 5)) },
  ];
  const raw = scenarios.map((scenario) => ({
    scenario,
    metrics: compactOptimizationMetrics(runEvaluationWindow(contract, developmentBars, evaluationStartIndex, developmentBars.length, { ...config, takerFeeRate: scenario.fee, slippageBps: scenario.slippage })),
  }));
  const base = raw[0]!.metrics;
  const points = raw.map(({ scenario, metrics }) => {
    const allowedReturnLoss = Math.max(0.05, Math.abs(base.netReturn) * 1.5);
    return {
      id: scenario.id,
      label: scenario.label,
      takerFeeRate: scenario.fee,
      slippageBps: scenario.slippage,
      metrics,
      passed: metrics.tradeCount >= 1 && metrics.netReturn >= base.netReturn - allowedReturnLoss && metrics.maximumDrawdown >= base.maximumDrawdown - 0.1,
    };
  });
  return { passed: points.every((point) => point.passed), points };
}

function quantile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)))]!;
}

function regimeEvidence(result: BacktestCoreResult, bars: Bar[]): RegimeEvidence[] {
  const window = Math.max(4, Math.min(20, Math.floor(bars.length / 10)));
  const states = bars.map((bar, index) => {
    if (index < window) return { timestamp: bar.timestamp, change: 0, volatility: 0 };
    const start = bars[index - window]!.close;
    const change = start ? bar.close / start - 1 : 0;
    const returns = bars.slice(index - window + 1, index + 1).map((item, offset, rows) => offset === 0 ? 0 : item.close / rows[offset - 1]!.close - 1);
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const volatility = Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1));
    return { timestamp: bar.timestamp, change, volatility };
  });
  const lowerReturn = quantile(states.map((state) => state.change), 0.33);
  const upperReturn = quantile(states.map((state) => state.change), 0.67);
  const highVolatility = quantile(states.map((state) => state.volatility), 0.75);
  const buckets = new Map<RegimeEvidence["regime"], ClosedTrade[]>();
  for (const trade of result.trades) {
    const state = states.reduce((found, item) => item.timestamp <= trade.entryTimestamp ? item : found, states[0]!);
    const regime: RegimeEvidence["regime"] = state.volatility > highVolatility
      ? "highVolatility"
      : state.change >= upperReturn ? "bull" : state.change <= lowerReturn ? "bear" : "range";
    const trades = buckets.get(regime) ?? [];
    trades.push(trade);
    buckets.set(regime, trades);
  }
  return (["bull", "bear", "range", "highVolatility"] as const).map((regime) => {
    const trades = buckets.get(regime) ?? [];
    const winners = trades.filter((trade) => trade.netPnl > 0).length;
    return { regime, tradeCount: trades.length, winRate: trades.length ? winners / trades.length : null, netPnl: trades.reduce((sum, trade) => sum + trade.netPnl, 0) };
  });
}

function buildRobustnessGate(
  baseContract: StrategyContract,
  candidateValues: Record<string, number>,
  definitions: ParameterDefinition[],
  selections: ParameterSelection[],
  developmentBars: Bar[],
  evaluationStartIndex: number,
  config: BacktestConfig,
  objective: OptimizationCoreResult["objective"],
  trialCount: number,
  improved: boolean,
): RobustnessGate {
  const candidateContract = applyParameters(baseContract, definitions, candidateValues);
  const walkForward = walkForwardEvidence(baseContract, candidateContract, developmentBars, config);
  const sensitivity = sensitivityEvidence(baseContract, candidateValues, definitions, selections, developmentBars, evaluationStartIndex, config, objective);
  const costStress = costStressEvidence(candidateContract, developmentBars, evaluationStartIndex, config);
  const validationResult = runEvaluationWindow(candidateContract, developmentBars, evaluationStartIndex, developmentBars.length, config);
  const regimes = regimeEvidence(validationResult, developmentBars.slice(evaluationStartIndex));
  const sharpe = validationResult.metrics.sharpe;
  const selectionAdjustedSharpe = sharpe === null ? null : sharpe / Math.sqrt(1 + Math.log(Math.max(1, trialCount)));
  const failedChecks = [
    ...(!improved ? ["候选没有稳定超过原始参数"] : []),
    ...(!walkForward.passed ? ["滚动样本外验证未通过"] : []),
    ...(!sensitivity.passed ? ["相邻参数敏感性过高"] : []),
    ...(!costStress.passed ? ["成本压力测试未通过"] : []),
  ];
  return {
    walkForward,
    sensitivity,
    costStress,
    regimes,
    multiplicity: {
      trialCount,
      selectionAdjustedSharpe,
      warning: trialCount > 1 ? `已从 ${trialCount} 组候选中选择；调整后夏普仅用于披露多次尝试惩罚，不等同于 Deflated Sharpe Ratio。` : null,
    },
    preBlindPassed: failedChecks.length === 0,
    failedChecks,
  };
}

function parameterLevels(definition: ParameterDefinition, selection: ParameterSelection): number[] {
  const values = Array.from({ length: selection.steps }, (_, index) => {
    const raw = selection.min + (selection.max - selection.min) * index / Math.max(1, selection.steps - 1);
    return definition.kind === "integer" ? Math.round(raw) : Number(raw.toPrecision(12));
  });
  values.push(definition.value);
  return [...new Set(values)].sort((left, right) => left - right);
}

function generateParameterCandidates(definitions: ParameterDefinition[], selections: ParameterSelection[], maximumTrials: number): Array<Record<string, number>> {
  const selected = selections.map((selection) => {
    const definition = definitions.find((item) => item.id === selection.id)!;
    return { definition, levels: parameterLevels(definition, selection) };
  });
  const combinations: Array<Record<string, number>> = [];
  const visit = (index: number, current: Record<string, number>) => {
    if (index === selected.length) {
      combinations.push({ ...current });
      return;
    }
    const parameter = selected[index]!;
    for (const value of parameter.levels) {
      current[parameter.definition.id] = value;
      visit(index + 1, current);
    }
  };
  visit(0, {});
  const baseline = Object.fromEntries(selected.map(({ definition }) => [definition.id, definition.value]));
  const baselineKey = JSON.stringify(baseline);
  const alternatives = combinations.filter((candidate) => JSON.stringify(candidate) !== baselineKey);
  if (alternatives.length <= maximumTrials - 1) return [baseline, ...alternatives];
  const sampled: Array<Record<string, number>> = [baseline];
  const used = new Set<number>();
  for (let index = 0; index < maximumTrials - 1; index += 1) {
    const position = Math.floor(index * (alternatives.length - 1) / Math.max(1, maximumTrials - 2));
    if (!used.has(position)) {
      used.add(position);
      sampled.push(alternatives[position]!);
    }
  }
  return sampled.slice(0, maximumTrials);
}

function markPareto(trials: OptimizationTrial[]): void {
  for (const trial of trials) {
    trial.pareto = !trials.some((other) => other.id !== trial.id
      && other.validation.netReturn >= trial.validation.netReturn
      && other.validation.maximumDrawdown >= trial.validation.maximumDrawdown
      && (other.validation.sharpe ?? Number.NEGATIVE_INFINITY) >= (trial.validation.sharpe ?? Number.NEGATIVE_INFINITY)
      && (other.validation.netReturn > trial.validation.netReturn
        || other.validation.maximumDrawdown > trial.validation.maximumDrawdown
        || (other.validation.sharpe ?? Number.NEGATIVE_INFINITY) > (trial.validation.sharpe ?? Number.NEGATIVE_INFINITY)));
  }
}

function parseSelections(value: unknown, definitions: ParameterDefinition[]): ParameterSelection[] {
  if (!Array.isArray(value) || value.length === 0) throw new RequestValidationError("请至少选择一个可调参数");
  if (value.length > MAX_OPTIMIZATION_PARAMETERS) throw new RequestValidationError(`一次最多调整 ${MAX_OPTIMIZATION_PARAMETERS} 个参数`);
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new RequestValidationError("参数实验范围无效");
    const record = item as Record<string, unknown>;
    const id = cleanString(record.id, 160);
    const definition = definitions.find((candidate) => candidate.id === id);
    if (!definition || seen.has(id)) throw new RequestValidationError(`未知或重复的策略参数 ${id || "（空）"}`);
    seen.add(id);
    let minimum = Number(record.min);
    let maximum = Number(record.max);
    const steps = Math.round(Number(record.steps));
    if (definition.kind === "integer") {
      minimum = Math.round(minimum);
      maximum = Math.round(maximum);
    }
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum >= maximum) throw new RequestValidationError(`${definition.label} 的上下限无效`);
    if (minimum < definition.hardMin || maximum > definition.hardMax) throw new RequestValidationError(`${definition.label} 超出安全边界 ${definition.hardMin}～${definition.hardMax}`);
    if (!Number.isInteger(steps) || steps < 2 || steps > 7) throw new RequestValidationError(`${definition.label} 的取值点数必须为 2～7`);
    return { id, min: minimum, max: maximum, steps };
  });
}

async function runOptimization(request: Request, env: BacktestEnv, identity: Identity): Promise<Response> {
  const body = await request.json() as Record<string, unknown>;
  const strategyId = cleanString(body.strategyId, 96);
  if (!strategyId) return fail("BAD_REQUEST", 400);
  if (!identity.user) return fail("AUTH_REQUIRED", 401);
  await ensureBacktestSchema(env.DB);
  const recent = await env.DB.prepare("SELECT COUNT(*) AS count FROM optimization_runs WHERE user_id = ? AND created_at > ?")
    .bind(identity.user.id, new Date(Date.now() - 60 * 60 * 1000).toISOString()).first<{ count: number }>();
  if ((recent?.count ?? 0) >= 3) return fail("RATE_LIMITED", 429, undefined, 600);
  const stored = await ownedStrategy(env.DB, identity, strategyId);
  if (!stored) return fail("NOT_FOUND", 404);
  if (!stored.confirmed_at) return fail("NOT_CONFIRMED", 409);
  const sessionId = stored.session_id;
  const strategy = JSON.parse(stored.result_json) as Record<string, unknown>;
  if (strategy.status !== "ready") return fail("NOT_RUNNABLE", 409);
  const contract = validateContract(strategy.contract);
  const definitions = extractParameterSchema(contract);
  if (definitions.length === 0) return json({ error: "这份策略没有可安全调整的数字参数" }, 409);
  const usingService = Boolean(env.BACKTEST_SERVICE_URL);
  const source = typeof strategy.source === "string" ? strategy.source : "";
  if (usingService && source === "") return fail("SOURCE_MISSING", 422);
  if (usingService) assertServiceSupported(source);
  const selections = parseSelections(body.parameters, definitions);
  const objective: OptimizationCoreResult["objective"] = body.objective === "return" || body.objective === "drawdown" ? body.objective : "balanced";
  const maximumTrials = Math.round(finite(body.maxTrials, 12, 6, MAX_OPTIMIZATION_TRIALS));
  const now = Date.now();
  const requestedEnd = Math.min(now - TIMEFRAME_MS[contract.timeframe], finite(body.endTime, now - TIMEFRAME_MS[contract.timeframe], 1_500_000_000_000, now));
  const defaultWindow = contract.timeframe === "1m" ? 3 * 24 * 60 * 60 * 1000 : contract.timeframe === "15m" ? 60 * 24 * 60 * 60 * 1000 : 365 * 24 * 60 * 60 * 1000;
  const requestedStart = finite(body.startTime, requestedEnd - defaultWindow, 1_500_000_000_000, requestedEnd - TIMEFRAME_MS[contract.timeframe]);
  // Aligned for the same reason as a plain backtest, and it matters more here:
  // an experiment id is derived from this window, so a drifting bound would mint
  // a fresh one-shot blind test every time the same experiment was requested.
  const { startTime, endTime } = alignWindow(requestedStart, requestedEnd, contract.timeframe);
  if ((endTime - startTime) / TIMEFRAME_MS[contract.timeframe] > MAX_BARS) return fail("RANGE_TOO_LARGE", 400, { timeframe: contract.timeframe, maxBars: MAX_BARS.toLocaleString("en-US") });
  const config: BacktestConfig = {
    initialCapital: finite(body.initialCapital, 10_000, 100, 100_000_000),
    takerFeeRate: finite(body.takerFeeRate, 0.00045, 0, 0.01),
    slippageBps: finite(body.slippageBps, 2, 0, 100),
    maxLeverage: finite(body.maxLeverage, 3, 1, 20),
    startTime,
    endTime,
  };
  const started = Date.now();
  const fetched = await fetchBinanceBars(env, request.url, stored.asset, stored.market, contract.timeframe, startTime, endTime);
  const bars = fetched.bars;
  if (bars.length < 60) return json({ error: "Stage 2 稳健性实验至少需要 60 根完整K线，以便隔离训练、滚动验证和盲测区间" }, 400);
  const blindIndex = Math.max(48, Math.min(bars.length - 12, Math.floor(bars.length * 0.8)));
  const developmentBars = bars.slice(0, blindIndex);
  const splitIndex = Math.max(12, Math.min(developmentBars.length - 12, Math.floor(developmentBars.length * 0.7)));
  const trainBars = developmentBars.slice(0, splitIndex);
  const barsDigest = await sha256Text(JSON.stringify(compactBars(bars)));
  const semanticLockHash = await sha256Text(semanticSkeleton(contract));
  const candidates = generateParameterCandidates(definitions, selections, maximumTrials);
  const sourceHash = await sha256Text(source);
  const cacheKey = await sha256Text(JSON.stringify({
    version: OPTIMIZATION_CACHE_VERSION,
    engine: usingService ? "cli-sandbox-service" : "proof-worker-contract",
    contract,
    semanticLockHash,
    selections,
    objective,
    maximumTrials,
    config,
    barsDigest,
    sourceHash,
  }));
  const id = await sha256Text(JSON.stringify({ version: OPTIMIZATION_CACHE_VERSION, sessionId, strategyId, cacheKey }));
  const existing = await env.DB.prepare(`SELECT result_json, blind_status, blind_result_json, adopted_strategy_id
    FROM optimization_runs WHERE id = ? AND session_id = ?`)
    .bind(id, sessionId).first<{ result_json: string; blind_status: string; blind_result_json: string | null; adopted_strategy_id: string | null }>();
  if (existing) return json({
    ...JSON.parse(existing.result_json) as Record<string, unknown>,
    blindStatus: existing.blind_status,
    blindResult: existing.blind_result_json ? JSON.parse(existing.blind_result_json) : null,
    adoptedStrategyId: existing.adopted_strategy_id,
    resultCache: "experiment-reused",
  });
  const objectKey = `${OPTIMIZATION_CACHE_VERSION}/results/${cacheKey}.json.gz`;
  const wasHot = HOT_OPTIMIZATION_RESULTS.has(objectKey);
  // Local fallback (legacy contract interpreter) when the service is unconfigured.
  const computeOptimizationLocally = async (): Promise<OptimizationCoreResult> => {
    const trials = candidates.map((parameters, index): OptimizationTrial => {
      const candidateContract = applyParameters(contract, definitions, parameters);
      const train = compactOptimizationMetrics(runContractBacktest(candidateContract, trainBars, config));
      const validation = compactOptimizationMetrics(runEvaluationWindow(candidateContract, developmentBars, splitIndex, developmentBars.length, config));
      return {
        id: `T${String(index + 1).padStart(2, "0")}`,
        parameters,
        train,
        validation,
        score: optimizationScore(train, validation, objective),
        pareto: false,
        isBaseline: index === 0,
      };
    });
    markPareto(trials);
    const baseline = trials[0]!;
    const ranked = [...trials].sort((left, right) => right.score - left.score);
    const challenger = ranked.find((trial) => !trial.isBaseline && trial.validation.tradeCount >= 2);
    const improved = Boolean(challenger && challenger.score > baseline.score + 0.005);
    const recommended = improved ? challenger! : baseline;
    const robustness = buildRobustnessGate(contract, recommended.parameters, definitions, selections, developmentBars, splitIndex, config, objective, trials.length, improved);
    return {
      schemaVersion: "optimization-2.0",
      semanticLockHash,
      split: {
        trainStart: new Date(trainBars[0]!.timestamp).toISOString(),
        trainEnd: new Date(trainBars.at(-1)!.timestamp + TIMEFRAME_MS[contract.timeframe] - 1).toISOString(),
        validationStart: new Date(developmentBars[splitIndex]!.timestamp).toISOString(),
        validationEnd: new Date(developmentBars.at(-1)!.timestamp + TIMEFRAME_MS[contract.timeframe] - 1).toISOString(),
        blindStart: new Date(bars[blindIndex]!.timestamp).toISOString(),
        blindEnd: new Date(bars.at(-1)!.timestamp + TIMEFRAME_MS[contract.timeframe] - 1).toISOString(),
        trainBars: trainBars.length,
        validationBars: developmentBars.length - splitIndex,
        blindBars: bars.length - blindIndex,
      },
      objective,
      trials,
      baselineTrialId: baseline.id,
      recommendedTrialId: recommended.id,
      outcome: improved ? "improved" : "baseline_retained",
      robustness,
    };
  };
  const cached = await HOT_OPTIMIZATION_RESULTS.getOrLoad(objectKey, async () => {
    const storedResult = await readObjectJson<OptimizationCoreResult>(env.CACHE, objectKey);
    if (storedResult) return { result: storedResult, tier: "object" as const };
    const result = usingService
      ? await runOptimizationOnService(env, { source, contract, selections, objective, maximumTrials, bars, config })
      : await computeOptimizationLocally();
    await writeObjectJson(env.CACHE, objectKey, result);
    return { result, tier: "computed" as const };
  });
  const resultCache = wasHot ? "memory-hit" : cached.tier === "object" ? "persistent-hit" : "miss";
  const response = {
    id,
    strategyId,
    strategyName: strategy.strategyName ?? "已确认策略",
    asset: stored.asset,
    market: stored.market,
    timeframe: contract.timeframe,
    engineVersion: usingService ? SERVICE_ENGINE_VERSION : "proof-worker-0.5.0",
    durationMs: Date.now() - started,
    dataSource: fetched.dataSource,
    dataWarnings: fetched.warnings,
    resultCache,
    load: OPTIMIZATION_GATE.load,
    parameterSchema: definitions.filter((definition) => selections.some((selection) => selection.id === definition.id)).map(publicParameter),
    selectedParameters: selections,
    lockedSemantics: ["交易周期", "开平仓动作", "多空方向", "指标与行情字段", "比较符和布尔结构", "成交时序"],
    validationNote: "总历史末尾 20% 已冻结为一次性盲测；前 80% 内按时间训练和验证。验证窗口使用此前历史预热指标，但预热期不交易、不计绩效。",
    blindStatus: "reserved",
    experimentConfig: { startTime, endTime, initialCapital: config.initialCapital, takerFeeRate: config.takerFeeRate, slippageBps: config.slippageBps, maxLeverage: config.maxLeverage, barsDigest },
    ...cached.result,
  };
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO optimization_runs
    (id, strategy_submission_id, user_id, session_id, created_at, semantic_lock_hash, objective, trial_count, result_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, strategyId, identity.user.id, sessionId, new Date().toISOString(), semanticLockHash, objective, cached.result.trials.length, JSON.stringify(response)).run();
  if (!inserted.meta.changes) {
    const concurrent = await env.DB.prepare(`SELECT result_json, blind_status, blind_result_json, adopted_strategy_id
      FROM optimization_runs WHERE id = ? AND session_id = ?`)
      .bind(id, sessionId).first<{ result_json: string; blind_status: string; blind_result_json: string | null; adopted_strategy_id: string | null }>();
    if (concurrent) return json({
      ...JSON.parse(concurrent.result_json) as Record<string, unknown>,
      blindStatus: concurrent.blind_status,
      blindResult: concurrent.blind_result_json ? JSON.parse(concurrent.blind_result_json) : null,
      adoptedStrategyId: concurrent.adopted_strategy_id,
      resultCache: "experiment-reused",
    });
  }
  return json(response);
}

interface StoredOptimizationResponse extends OptimizationCoreResult {
  id: string;
  strategyId: string;
  strategyName: string;
  asset: string;
  market: string;
  timeframe: Timeframe;
  selectedParameters: ParameterSelection[];
  parameterSchema: PublicParameterDefinition[];
  experimentConfig: BacktestConfig & { barsDigest: string };
}

async function revealBlindTest(request: Request, env: BacktestEnv, identity: Identity): Promise<Response> {
  const body = await request.json() as Record<string, unknown>;
  const optimizationId = cleanString(body.optimizationId, 96);
  if (!optimizationId) return fail("BAD_REQUEST", 400);
  if (!identity.user) return fail("AUTH_REQUIRED", 401);
  await ensureBacktestSchema(env.DB);
  const sessionId = await ownedOptimizationSession(env.DB, identity, optimizationId);
  if (!sessionId) return fail("NOT_FOUND", 404);
  const storedRun = await env.DB.prepare(`SELECT strategy_submission_id, result_json, blind_status, blind_result_json
    FROM optimization_runs WHERE id = ? AND session_id = ?`)
    .bind(optimizationId, sessionId).first<{ strategy_submission_id: string; result_json: string; blind_status: string; blind_result_json: string | null }>();
  if (!storedRun) return fail("NOT_FOUND", 404);
  if (storedRun.blind_status === "passed" || storedRun.blind_status === "failed") {
    if (!storedRun.blind_result_json) return json({ error: "盲测状态已锁定，但结果收据缺失" }, 409);
    return json({ ...JSON.parse(storedRun.blind_result_json) as Record<string, unknown>, reused: true });
  }
  if (storedRun.blind_status === "running") return json({ error: "盲测正在执行，请稍后查看同一实验" }, 409);
  const experiment = JSON.parse(storedRun.result_json) as StoredOptimizationResponse;
  if (!experiment.robustness?.preBlindPassed) return json({ error: "预盲测稳健性门禁尚未通过，最终盲测保持封存", failedChecks: experiment.robustness?.failedChecks ?? [] }, 409);
  const claimed = await env.DB.prepare("UPDATE optimization_runs SET blind_status = 'running' WHERE id = ? AND session_id = ? AND blind_status = 'reserved'")
    .bind(optimizationId, sessionId).run();
  if (!claimed.meta.changes) return json({ error: "盲测已被另一请求领取，请稍后查看" }, 409);
  try {
    const storedStrategy = await env.DB.prepare("SELECT result_json, asset, market FROM strategy_submissions WHERE id = ? AND session_id = ?")
      .bind(storedRun.strategy_submission_id, sessionId).first<{ result_json: string; asset: string; market: string }>();
    if (!storedStrategy) throw new Error("原始策略版本不存在，盲测不能继续");
    const strategy = JSON.parse(storedStrategy.result_json) as Record<string, unknown>;
    const contract = validateContract(strategy.contract);
    const definitions = extractParameterSchema(contract);
    const recommended = experiment.trials.find((trial) => trial.id === experiment.recommendedTrialId);
    const baseline = experiment.trials.find((trial) => trial.id === experiment.baselineTrialId);
    if (!recommended || !baseline || recommended.isBaseline) throw new Error("实验没有可进入盲测的改进候选");
    const config = experiment.experimentConfig;
    const fetched = await fetchBinanceBars(env, request.url, storedStrategy.asset, storedStrategy.market, contract.timeframe, config.startTime, config.endTime);
    const bars = fetched.bars;
    const digest = await sha256Text(JSON.stringify(compactBars(bars)));
    if (digest !== config.barsDigest) throw new Error("历史数据快照已变化；为保护盲测，实验已停止且不会混用新数据");
    const blindStart = new Date(experiment.split.blindStart).getTime();
    const usingService = Boolean(env.BACKTEST_SERVICE_URL);
    const source = typeof strategy.source === "string" ? strategy.source : "";
    if (usingService && source === "") throw new Error("原始策略没有程序源码，盲测不能继续");
    let baselineResult: OptimizationMetrics;
    let candidateResult: OptimizationMetrics;
    let checks: Array<{ id: string; label: string; passed: boolean; detail: string }>;
    if (usingService) {
      const outcome = await runBlindOnService(env, {
        source,
        contract,
        candidateParameters: recommended.parameters,
        bars,
        config,
        blindStartTime: blindStart,
      });
      baselineResult = outcome.baseline;
      candidateResult = outcome.candidate;
      checks = outcome.checks;
    } else {
      const candidateContract = applyParameters(contract, definitions, recommended.parameters);
      baselineResult = compactOptimizationMetrics(runContractBacktest(contract, bars, config, { evaluationStartTime: blindStart }));
      candidateResult = compactOptimizationMetrics(runContractBacktest(candidateContract, bars, config, { evaluationStartTime: blindStart }));
      checks = [
        { id: "minimumTrades", label: "盲测交易样本", passed: candidateResult.tradeCount >= 2, detail: `${candidateResult.tradeCount} 笔，门槛为 2 笔` },
        { id: "relativeReturn", label: "相对收益没有坍塌", passed: candidateResult.netReturn >= baselineResult.netReturn - 0.01, detail: `候选 ${candidateResult.netReturn.toFixed(4)} / 原始 ${baselineResult.netReturn.toFixed(4)}` },
        { id: "relativeDrawdown", label: "相对回撤没有恶化", passed: candidateResult.maximumDrawdown >= baselineResult.maximumDrawdown - 0.03, detail: `候选 ${candidateResult.maximumDrawdown.toFixed(4)} / 原始 ${baselineResult.maximumDrawdown.toFixed(4)}` },
      ];
    }
    const passed = checks.every((check) => check.passed);
    const consumedAt = new Date().toISOString();
    const blindResult = {
      schemaVersion: "blind-test-1.0",
      optimizationId,
      consumedAt,
      candidateTrialId: recommended.id,
      status: passed ? "passed" : "failed",
      baseline: baselineResult,
      candidate: candidateResult,
      checks,
      canCreateVersion: passed,
      dataSource: fetched.dataSource,
      blindWindow: { start: experiment.split.blindStart, end: experiment.split.blindEnd, bars: experiment.split.blindBars },
      reused: false,
    };
    await env.DB.prepare("UPDATE optimization_runs SET blind_status = ?, blind_consumed_at = ?, blind_result_json = ? WHERE id = ? AND session_id = ? AND blind_status = 'running'")
      .bind(passed ? "passed" : "failed", consumedAt, JSON.stringify(blindResult), optimizationId, sessionId).run();
    return json(blindResult);
  } catch (error) {
    await env.DB.prepare("UPDATE optimization_runs SET blind_status = 'reserved' WHERE id = ? AND session_id = ? AND blind_status = 'running'")
      .bind(optimizationId, sessionId).run();
    throw error;
  }
}

async function createOptimizedVersion(request: Request, env: BacktestEnv, identity: Identity): Promise<Response> {
  const body = await request.json() as Record<string, unknown>;
  const optimizationId = cleanString(body.optimizationId, 96);
  if (!optimizationId) return fail("BAD_REQUEST", 400);
  if (!identity.user) return fail("AUTH_REQUIRED", 401);
  await ensureBacktestSchema(env.DB);
  const sessionId = await ownedOptimizationSession(env.DB, identity, optimizationId);
  if (!sessionId) return fail("NOT_FOUND", 404);
  const storedRun = await env.DB.prepare(`SELECT strategy_submission_id, result_json, blind_status, adopted_strategy_id
    FROM optimization_runs WHERE id = ? AND session_id = ?`)
    .bind(optimizationId, sessionId).first<{ strategy_submission_id: string; result_json: string; blind_status: string; adopted_strategy_id: string | null }>();
  if (!storedRun) return fail("NOT_FOUND", 404);
  if (storedRun.blind_status !== "passed") return json({ error: "只有通过最终盲测的候选才能创建策略版本" }, 409);
  if (storedRun.adopted_strategy_id) return json({ id: storedRun.adopted_strategy_id, optimizationId, reused: true });
  const experiment = JSON.parse(storedRun.result_json) as StoredOptimizationResponse;
  const recommended = experiment.trials.find((trial) => trial.id === experiment.recommendedTrialId);
  if (!recommended || recommended.isBaseline) return json({ error: "实验没有可版本化的改进候选" }, 409);
  const storedStrategy = await env.DB.prepare("SELECT intent, result_json, asset, market FROM strategy_submissions WHERE id = ? AND session_id = ?")
    .bind(storedRun.strategy_submission_id, sessionId).first<{ intent: string; result_json: string; asset: string; market: string }>();
  if (!storedStrategy) return json({ error: "原始策略版本不存在" }, 404);
  const strategy = JSON.parse(storedStrategy.result_json) as Record<string, unknown>;
  const contract = validateContract(strategy.contract);
  const definitions = extractParameterSchema(contract);
  const candidateContract = applyParameters(contract, definitions, recommended.parameters);
  const semanticLockHash = await sha256Text(semanticSkeleton(candidateContract));
  if (semanticLockHash !== experiment.semanticLockHash) throw new Error("候选策略未通过语义锁复核");
  // Materialize the real program for the parameter version so the single engine
  // can execute it. The legacy path (no service) keeps an empty source flagged
  // as contract-derived.
  const usingService = Boolean(env.BACKTEST_SERVICE_URL);
  const baseSource = typeof strategy.source === "string" ? strategy.source : "";
  const candidateSource = usingService
    ? await materializeSourceOnService(env, baseSource, contract, recommended.parameters)
    : "";
  const id = crypto.randomUUID();
  const changes = experiment.parameterSchema.map((parameter) => ({
    id: parameter.id,
    label: parameter.label,
    from: parameter.value,
    to: recommended.parameters[parameter.id] ?? parameter.value,
  })).filter((change) => change.from !== change.to);
  const strategyName = `${String(strategy.strategyName ?? "已确认策略")} · 稳健参数版`;
  const artifact = {
    ...strategy,
    id,
    status: "ready",
    strategyName,
    summary: `基于已锁定策略语义创建的参数版本；通过滚动验证、邻域敏感性、成本压力和一次性最终盲测。`,
    contract: candidateContract,
    source: candidateSource,
    programStatus: candidateSource === "" ? "contract-derived" : "program-derived",
    parentStrategyId: storedRun.strategy_submission_id,
    optimizationId,
    semanticLockHash,
    parameterChanges: changes,
    generation: { model: "deterministic-parameter-lab", latencyMs: 0, responseId: null, cacheStatus: "versioned" },
  };
  const claimed = await env.DB.prepare("UPDATE optimization_runs SET adopted_strategy_id = ? WHERE id = ? AND session_id = ? AND blind_status = 'passed' AND adopted_strategy_id IS NULL")
    .bind(id, optimizationId, sessionId).run();
  if (!claimed.meta.changes) {
    const current = await env.DB.prepare("SELECT adopted_strategy_id FROM optimization_runs WHERE id = ? AND session_id = ?")
      .bind(optimizationId, sessionId).first<{ adopted_strategy_id: string | null }>();
    return json({ id: current?.adopted_strategy_id, optimizationId, reused: true });
  }
  try {
    // A parameter version inherits the confirmation of the strategy it derives
    // from: its semantics are locked by the experiment, not re-read by a model.
    const versionedAt = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO strategy_submissions
      (id, user_id, session_id, created_at, confirmed_at, title, intent, market, asset, status, model, result_json, latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'deterministic-parameter-lab', ?, 0)`)
      .bind(id, identity.user.id, sessionId, versionedAt, versionedAt, strategyName, storedStrategy.intent, storedStrategy.market, storedStrategy.asset, JSON.stringify(artifact)).run();
  } catch (error) {
    await env.DB.prepare("UPDATE optimization_runs SET adopted_strategy_id = NULL WHERE id = ? AND session_id = ? AND adopted_strategy_id = ?")
      .bind(optimizationId, sessionId, id).run();
    throw error;
  }
  return json({ id, optimizationId, strategyName, parentStrategyId: storedRun.strategy_submission_id, semanticLockHash, parameterChanges: changes, reused: false });
}

/**
 * The most recent run for a strategy, used to hydrate step 4 on a fresh page load.
 * Bars and the equity curve are not stored, so the parameter lab receives exactly
 * what it needs: the discovered parameters, the window and the cost configuration.
 */
export async function loadLatestBacktest(db: D1Database, identity: Identity, strategyId: string): Promise<Record<string, unknown> | null> {
  const strategy = await ownedStrategy(db, identity, strategyId);
  if (!strategy) return null;
  await ensureBacktestSchema(db);
  const row = await db.prepare(
    "SELECT result_json FROM backtest_runs WHERE strategy_submission_id = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(strategyId).first<{ result_json: string }>();
  if (!row) return null;
  try {
    const stored = JSON.parse(row.result_json) as Record<string, unknown>;
    // The stored receipt omits the series; the lab renders no chart, so empty
    // arrays keep the client type honest instead of leaving the fields undefined.
    return { ...stored, bars: [], equityCurve: [] };
  } catch {
    return null;
  }
}

export async function handleBacktestApi(request: Request, env: BacktestEnv, identity: Identity): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const supported = ["/api/backtest/run", "/api/optimization/run", "/api/optimization/blind", "/api/optimization/adopt"];
  if (!supported.includes(pathname)) return null;
  try {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    // The gates wrap whole handlers, not just their executors: a handler holds
    // its history from the first archive read to the last write, and that span
    // is what has to be bounded. Adopting a version is metadata only and needs
    // no slot.
    if (pathname === "/api/optimization/run") return await OPTIMIZATION_GATE.run(() => runOptimization(request, env, identity));
    if (pathname === "/api/optimization/blind") return await BACKTEST_GATE.run(() => revealBlindTest(request, env, identity));
    if (pathname === "/api/optimization/adopt") return await createOptimizedVersion(request, env, identity);
    return await BACKTEST_GATE.run(() => runBacktest(request, env, identity));
  } catch (error) {
    if (error instanceof BusyError) return fail("SERVER_BUSY", 429, undefined, error.retryAfterSeconds);
    if (error instanceof CodedError) return fail(error.code, 400, error.params);
    const status = error instanceof RequestValidationError ? 400 : 500;
    // The interpreter's own message stays in the payload for the research
    // disclosure; the stable code is what the UI renders in the active locale.
    return json({
      error: error instanceof Error ? error.message : "",
      code: error instanceof RequestValidationError
        ? "BAD_REQUEST"
        : pathname.includes("optimization") ? "OPTIMIZATION_FAILED" : "BACKTEST_FAILED",
    }, status);
  }
}
