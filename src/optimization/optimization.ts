import type { BacktestConfig, ClosedTrade, MarketBar } from "../core/types.js";
import { runBacktest } from "../runtime/backtest.js";
import { calculateBacktestMetrics } from "../runtime/backtest-metrics.js";
import type { ContractTimeframe, StrategyContract } from "../semantics/contract.js";
import { applyParametersToSource } from "./program-apply.js";
import {
  extractParameterSchema,
  generateParameterCandidates,
  semanticSkeleton,
  type ParameterDefinition,
  type ParameterSelection,
} from "./parameter-discovery.js";

/**
 * The parameter lab executed on the real program. This is a faithful port of the
 * Web's `web/worker/backtest-api.ts` optimization pipeline; the one structural
 * change is that every inner backtest runs `runBacktest` on a program variant
 * (the base source with the tuned numbers rewritten) instead of the legacy
 * contract interpreter.
 */

export interface OptimizationMetrics {
  netReturn: number;
  maximumDrawdown: number;
  sharpe: number | null;
  winRate: number | null;
  profitFactor: number | null;
  tradeCount: number;
}

export interface OptimizationTrial {
  id: string;
  parameters: Record<string, number>;
  train: OptimizationMetrics;
  validation: OptimizationMetrics;
  score: number;
  pareto: boolean;
  isBaseline: boolean;
}

export interface WalkForwardFold {
  id: string;
  trainBars: number;
  validationBars: number;
  validationStart: string;
  validationEnd: string;
  baseline: OptimizationMetrics;
  candidate: OptimizationMetrics;
  passed: boolean;
}

export interface SensitivityPoint {
  parameterId: string;
  direction: "lower" | "higher";
  value: number;
  metrics: OptimizationMetrics;
  retainedFraction: number | null;
  passed: boolean;
}

export interface CostStressPoint {
  id: "base" | "double" | "severe";
  label: string;
  takerFeeRate: number;
  slippageBps: number;
  metrics: OptimizationMetrics;
  passed: boolean;
}

export interface RegimeEvidence {
  regime: "bull" | "bear" | "range" | "highVolatility";
  tradeCount: number;
  winRate: number | null;
  netPnl: number;
}

export interface RobustnessGate {
  walkForward: { passed: boolean; positiveFolds: number; folds: WalkForwardFold[] };
  sensitivity: { passed: boolean; stablePoints: number; totalPoints: number; points: SensitivityPoint[] };
  costStress: { passed: boolean; points: CostStressPoint[] };
  regimes: RegimeEvidence[];
  multiplicity: { trialCount: number; selectionAdjustedSharpe: number | null; warning: string | null };
  preBlindPassed: boolean;
  failedChecks: string[];
}

export interface OptimizationCoreResult {
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

export interface OptimizationInput {
  source: string;
  contract: StrategyContract;
  selections: ParameterSelection[];
  objective: "balanced" | "return" | "drawdown";
  maximumTrials: number;
  bars: MarketBar[];
  config: BacktestConfig;
}

export type OptimizationObjective = OptimizationCoreResult["objective"];

const TIMEFRAME_MS: Record<ContractTimeframe, number> = {
  "1m": 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
};

function compactResult(result: Awaited<ReturnType<typeof runBacktest>>): OptimizationMetrics {
  const metrics = calculateBacktestMetrics(result);
  return {
    netReturn: metrics.netReturn,
    maximumDrawdown: metrics.maximumDrawdown,
    sharpe: metrics.sharpe,
    winRate: metrics.winRate,
    profitFactor: metrics.profitFactor,
    tradeCount: metrics.tradeCount,
  };
}

function optimizationScore(train: OptimizationMetrics, validation: OptimizationMetrics, objective: OptimizationObjective): number {
  const gap = Math.abs(train.netReturn - validation.netReturn);
  const lowTradePenalty = Math.max(0, 3 - validation.tradeCount) * 0.08;
  const sharpe = Math.max(-5, Math.min(5, validation.sharpe ?? 0));
  if (objective === "return") return validation.netReturn + validation.maximumDrawdown * 0.25 - gap * 0.35 - lowTradePenalty;
  if (objective === "drawdown") return validation.netReturn * 0.5 + validation.maximumDrawdown * 1.5 + sharpe * 0.03 - gap * 0.3 - lowTradePenalty;
  return validation.netReturn * 1.6 + train.netReturn * 0.2 + validation.maximumDrawdown * 0.9
    + sharpe * 0.04 + (validation.winRate ?? 0) * 0.03 - gap * 0.6 - lowTradePenalty;
}

/** Runs one program variant over a bar prefix, optionally from a window start. */
async function runProgramWindow(
  source: string,
  bars: MarketBar[],
  config: BacktestConfig,
  window?: { startIndex: number; endIndex: number },
): Promise<OptimizationMetrics> {
  if (!window) {
    const result = await runBacktest(source, bars, config);
    return compactResult(result);
  }
  const boundedStart = Math.max(0, Math.min(window.startIndex, bars.length - 2));
  const boundedEnd = Math.max(boundedStart + 2, Math.min(window.endIndex, bars.length));
  const result = await runBacktest(source, bars.slice(0, boundedEnd), {
    ...config,
    evaluationStartTime: bars[boundedStart]!.timestamp,
  });
  return compactResult(result);
}

async function walkForwardEvidence(
  baselineSource: string,
  candidateSource: string,
  developmentBars: MarketBar[],
  config: BacktestConfig,
): Promise<RobustnessGate["walkForward"]> {
  const initialTrain = Math.max(6, Math.floor(developmentBars.length * 0.5));
  const remaining = developmentBars.length - initialTrain;
  const folds: WalkForwardFold[] = [];
  for (let index = 0; index < 3; index += 1) {
    const validationStart = initialTrain + Math.floor(remaining * index / 3);
    const validationEnd = initialTrain + Math.floor(remaining * (index + 1) / 3);
    if (validationEnd - validationStart < 2) continue;
    const baseline = await runProgramWindow(baselineSource, developmentBars, config, { startIndex: validationStart, endIndex: validationEnd });
    const candidate = await runProgramWindow(candidateSource, developmentBars, config, { startIndex: validationStart, endIndex: validationEnd });
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

async function sensitivityEvidence(
  baseSource: string,
  contract: StrategyContract,
  definitions: ParameterDefinition[],
  candidateValues: Record<string, number>,
  selections: ParameterSelection[],
  developmentBars: MarketBar[],
  evaluationStartIndex: number,
  config: BacktestConfig,
  objective: OptimizationObjective,
): Promise<RobustnessGate["sensitivity"]> {
  const candidateSource = applyParametersToSource(baseSource, contract, definitions, candidateValues);
  const baseMetrics = await runProgramWindow(candidateSource, developmentBars, config, { startIndex: evaluationStartIndex, endIndex: developmentBars.length });
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
      const perturbedSource = applyParametersToSource(baseSource, contract, definitions, values);
      const metrics = await runProgramWindow(perturbedSource, developmentBars, config, { startIndex: evaluationStartIndex, endIndex: developmentBars.length });
      const score = optimizationScore(metrics, metrics, objective);
      const tolerance = Math.max(0.03, Math.abs(baseScore) * 0.5);
      const retainedFraction = Math.abs(baseMetrics.netReturn) > 0.000001 ? metrics.netReturn / baseMetrics.netReturn : null;
      points.push({ parameterId: selection.id, direction, value: bounded, metrics, retainedFraction, passed: metrics.tradeCount >= 1 && score >= baseScore - tolerance });
    }
  }
  const stablePoints = points.filter((point) => point.passed).length;
  return { passed: points.length > 0 && stablePoints >= Math.ceil(points.length * 0.6), stablePoints, totalPoints: points.length, points };
}

async function costStressEvidence(
  candidateSource: string,
  developmentBars: MarketBar[],
  evaluationStartIndex: number,
  config: BacktestConfig,
): Promise<RobustnessGate["costStress"]> {
  const scenarios: Array<{ id: CostStressPoint["id"]; label: string; fee: number; slippage: number }> = [
    { id: "base", label: "当前成本", fee: config.takerFeeRate, slippage: config.slippageBps },
    { id: "double", label: "双倍成本", fee: Math.min(0.01, config.takerFeeRate * 2), slippage: Math.min(100, config.slippageBps * 2) },
    { id: "severe", label: "严重冲击", fee: Math.min(0.01, config.takerFeeRate * 3), slippage: Math.min(100, Math.max(config.slippageBps * 3, config.slippageBps + 5)) },
  ];
  const raw = await Promise.all(scenarios.map(async (scenario) => ({
    scenario,
    metrics: await runProgramWindow(candidateSource, developmentBars, { ...config, takerFeeRate: scenario.fee, slippageBps: scenario.slippage }, { startIndex: evaluationStartIndex, endIndex: developmentBars.length }),
  })));
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

function regimeEvidence(result: Awaited<ReturnType<typeof runBacktest>>, bars: MarketBar[]): RegimeEvidence[] {
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

async function buildRobustnessGate(
  baseSource: string,
  contract: StrategyContract,
  definitions: ParameterDefinition[],
  candidateValues: Record<string, number>,
  selections: ParameterSelection[],
  developmentBars: MarketBar[],
  evaluationStartIndex: number,
  config: BacktestConfig,
  objective: OptimizationObjective,
  trialCount: number,
  improved: boolean,
): Promise<RobustnessGate> {
  const candidateSource = applyParametersToSource(baseSource, contract, definitions, candidateValues);
  const walkForward = await walkForwardEvidence(baseSource, candidateSource, developmentBars, config);
  const sensitivity = await sensitivityEvidence(baseSource, contract, definitions, candidateValues, selections, developmentBars, evaluationStartIndex, config, objective);
  const costStress = await costStressEvidence(candidateSource, developmentBars, evaluationStartIndex, config);
  const validationResult = await runBacktest(candidateSource, developmentBars, { ...config, evaluationStartTime: developmentBars[evaluationStartIndex]!.timestamp });
  const regimes = regimeEvidence(validationResult, developmentBars.slice(evaluationStartIndex));
  const sharpe = calculateBacktestMetrics(validationResult).sharpe;
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

/**
 * Runs the parameter lab on the real program and returns the immutable core
 * result. The final 20% of history is not touched here; the blind test consumes
 * it separately (see `runBlindTest`).
 */
export async function runParameterOptimization(input: OptimizationInput): Promise<OptimizationCoreResult> {
  const { source, contract, selections, objective, maximumTrials, bars, config } = input;
  const definitions = extractParameterSchema(contract);
  const blindIndex = Math.max(48, Math.min(bars.length - 12, Math.floor(bars.length * 0.8)));
  const developmentBars = bars.slice(0, blindIndex);
  const splitIndex = Math.max(12, Math.min(developmentBars.length - 12, Math.floor(developmentBars.length * 0.7)));
  const trainBars = developmentBars.slice(0, splitIndex);
  const semanticLockHash = await sha256Text(semanticSkeleton(contract));
  const candidates = generateParameterCandidates(definitions, selections, maximumTrials);

  const trials: OptimizationTrial[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const parameters = candidates[index]!;
    const candidateSource = applyParametersToSource(source, contract, definitions, parameters);
    const train = await runProgramWindow(candidateSource, trainBars, config);
    const validation = await runProgramWindow(candidateSource, developmentBars, config, { startIndex: splitIndex, endIndex: developmentBars.length });
    trials.push({
      id: `T${String(index + 1).padStart(2, "0")}`,
      parameters,
      train,
      validation,
      score: optimizationScore(train, validation, objective),
      pareto: false,
      isBaseline: index === 0,
    });
  }
  markPareto(trials);
  const baseline = trials[0]!;
  const ranked = [...trials].sort((left, right) => right.score - left.score);
  const challenger = ranked.find((trial) => !trial.isBaseline && trial.validation.tradeCount >= 2);
  const improved = Boolean(challenger && challenger.score > baseline.score + 0.005);
  const recommended = improved ? challenger! : baseline;

  const robustness = await buildRobustnessGate(
    source,
    contract,
    definitions,
    recommended.parameters,
    selections,
    developmentBars,
    splitIndex,
    config,
    objective,
    trials.length,
    improved,
  );

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
}

async function sha256Text(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}
