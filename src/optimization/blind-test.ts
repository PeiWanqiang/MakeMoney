import type { BacktestConfig, MarketBar } from "../core/types.js";
import { runBacktest } from "../runtime/backtest.js";
import { calculateBacktestMetrics } from "../runtime/backtest-metrics.js";
import type { StrategyContract } from "../semantics/contract.js";
import type { OptimizationMetrics } from "./optimization.js";
import type { ParameterDefinition } from "./parameter-discovery.js";
import { applyParametersToSource } from "./program-apply.js";

/**
 * One-shot final blind test as pure computation. The caller owns the state
 * machine: it must reserve the blind window, call this exactly once, and persist
 * the receipt. This function only evaluates the baseline program and the
 * recommended candidate on the frozen tail of history.
 */

export interface BlindCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface BlindTestOutcome {
  passed: boolean;
  baseline: OptimizationMetrics;
  candidate: OptimizationMetrics;
  checks: BlindCheck[];
}

export interface BlindTestInput {
  source: string;
  contract: StrategyContract;
  definitions: ParameterDefinition[];
  candidateParameters: Record<string, number>;
  bars: MarketBar[];
  config: BacktestConfig;
  blindStartTime: number;
}

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

export async function runBlindTest(input: BlindTestInput): Promise<BlindTestOutcome> {
  const baseline = compactResult(await runBacktest(input.source, input.bars, {
    ...input.config,
    evaluationStartTime: input.blindStartTime,
  }));
  const candidateSource = applyParametersToSource(input.source, input.contract, input.definitions, input.candidateParameters);
  const candidate = compactResult(await runBacktest(candidateSource, input.bars, {
    ...input.config,
    evaluationStartTime: input.blindStartTime,
  }));

  const checks: BlindCheck[] = [
    { id: "minimumTrades", label: "盲测交易样本", passed: candidate.tradeCount >= 2, detail: `${candidate.tradeCount} 笔，门槛为 2 笔` },
    { id: "relativeReturn", label: "相对收益没有坍塌", passed: candidate.netReturn >= baseline.netReturn - 0.01, detail: `候选 ${candidate.netReturn.toFixed(4)} / 原始 ${baseline.netReturn.toFixed(4)}` },
    { id: "relativeDrawdown", label: "相对回撤没有恶化", passed: candidate.maximumDrawdown >= baseline.maximumDrawdown - 0.03, detail: `候选 ${candidate.maximumDrawdown.toFixed(4)} / 原始 ${baseline.maximumDrawdown.toFixed(4)}` },
  ];
  return { passed: checks.every((check) => check.passed), baseline, candidate, checks };
}
