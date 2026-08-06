"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { describeApiFailure, type ApiErrorPayload } from "./api-error";
import BacktestChart, { type BacktestBar, type BacktestIndicator, type BacktestTrade, type EquityPoint } from "./backtest-chart";
import { getMessages } from "./i18n";
import { localePath, LOCALE_TAG, type Locale } from "./i18n/locales";

/** Locale-independent numeric formatting shared by both steps. */
function percent(value: number | null): string {
  return value === null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function number(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

export interface BacktestResult {
  id: string;
  strategyId: string;
  strategyName: string;
  asset: string;
  market: string;
  timeframe: string;
  dataSource: string;
  dataWarnings: string[];
  engineVersion: string;
  executionModel: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  performance: {
    dataMs: number;
    executionMs: number;
    klineCache: { hot: number; local: number; object: number; external: number };
    resultCache: "memory-hit" | "persistent-hit" | "miss";
  };
  optimization: {
    schemaVersion: "parameters-1.0";
    semanticLockHash: string;
    lockedSemantics: string[];
    parameters: OptimizationParameter[];
  };
  barCount: number;
  config: { initialCapital: number; takerFeeRate: number; slippageBps: number; maxLeverage: number };
  initialCapital: number;
  finalEquity: number;
  metrics: {
    netReturn: number;
    maximumDrawdown: number;
    sharpe: number | null;
    winRate: number | null;
    profitFactor: number | null;
    tradeCount: number;
    winningTrades: number;
    losingTrades: number;
    fees: number;
    slippageCost: number;
    buyAndHoldReturn: number;
  };
  trades: BacktestTrade[];
  /**
   * The chart series are optional because the stored row drops them: a result
   * restored from the database (step 4 reads the latest run) carries the
   * metrics and the trades but not the history behind them.
   */
  equityCurve?: EquityPoint[];
  /** Points before server-side decimation, so the chart can say what it shows. */
  equityCurvePoints?: number;
  bars?: BacktestBar[];
  /** The indicator lines the confirmed rules read, one value per bar. */
  indicators?: BacktestIndicator[];
}

interface OptimizationParameter {
  id: string;
  label: string;
  context: string;
  value: number;
  kind: "integer" | "number";
  unit: "bars" | "ratio" | "riskReward" | "quote" | "value";
  suggestedMin: number;
  suggestedMax: number;
  suggestedSteps: number;
  hardBounds: { min: number; max: number };
}

interface ParameterDraft extends OptimizationParameter {
  selected: boolean;
  min: number;
  max: number;
  steps: number;
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

interface OptimizationMetrics {
  netReturn: number;
  maximumDrawdown: number;
  sharpe: number | null;
  winRate: number | null;
  profitFactor: number | null;
  tradeCount: number;
}

interface OptimizationResult {
  id: string;
  strategyId: string;
  strategyName: string;
  asset: string;
  market: string;
  timeframe: string;
  engineVersion: string;
  durationMs: number;
  dataSource: string;
  dataWarnings: string[];
  resultCache: "memory-hit" | "persistent-hit" | "miss" | "experiment-reused";
  parameterSchema: OptimizationParameter[];
  selectedParameters: Array<{ id: string; min: number; max: number; steps: number }>;
  lockedSemantics: string[];
  validationNote: string;
  schemaVersion: "optimization-2.0";
  semanticLockHash: string;
  split: { trainStart: string; trainEnd: string; validationStart: string; validationEnd: string; blindStart: string; blindEnd: string; trainBars: number; validationBars: number; blindBars: number };
  objective: "balanced" | "return" | "drawdown";
  trials: OptimizationTrial[];
  baselineTrialId: string;
  recommendedTrialId: string;
  outcome: "improved" | "baseline_retained";
  blindStatus: "reserved" | "running" | "passed" | "failed";
  blindResult?: BlindTestResult | null;
  adoptedStrategyId?: string | null;
  robustness: {
    walkForward: { passed: boolean; positiveFolds: number; folds: Array<{ id: string; trainBars: number; validationBars: number; validationStart: string; validationEnd: string; baseline: OptimizationMetrics; candidate: OptimizationMetrics; passed: boolean }> };
    sensitivity: { passed: boolean; stablePoints: number; totalPoints: number; points: Array<{ parameterId: string; direction: "lower" | "higher"; value: number; metrics: OptimizationMetrics; retainedFraction: number | null; passed: boolean }> };
    costStress: { passed: boolean; points: Array<{ id: "base" | "double" | "severe"; label: string; takerFeeRate: number; slippageBps: number; metrics: OptimizationMetrics; passed: boolean }> };
    regimes: Array<{ regime: "bull" | "bear" | "range" | "highVolatility"; tradeCount: number; winRate: number | null; netPnl: number }>;
    multiplicity: { trialCount: number; selectionAdjustedSharpe: number | null; warning: string | null };
    preBlindPassed: boolean;
    failedChecks: string[];
  };
}

interface BlindTestResult {
  schemaVersion: "blind-test-1.0";
  optimizationId: string;
  consumedAt: string;
  candidateTrialId: string;
  status: "passed" | "failed";
  baseline: OptimizationMetrics;
  candidate: OptimizationMetrics;
  checks: Array<{ id: string; label: string; passed: boolean; detail: string }>;
  canCreateVersion: boolean;
  blindWindow: { start: string; end: string; bars: number };
  reused: boolean;
}

interface AdoptedVersion {
  id: string;
  optimizationId: string;
  strategyName?: string;
  parentStrategyId?: string;
  semanticLockHash?: string;
  parameterChanges?: Array<{ id: string; label: string; from: number; to: number }>;
  reused: boolean;
}

interface Props {
  locale: Locale;
  /** Which of the two routed steps this instance renders. */
  step: "backtest" | "optimize";
  strategyId: string;
  strategyName: string;
  asset: string;
  market: string;
  timeframe: string;
  /** The stored run that step 4 tunes against; null on the backtest route. */
  initialResult?: BacktestResult | null;
}

function dateInput(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function defaultDays(timeframe: string): number {
  if (timeframe === "1m") return 3;
  if (timeframe === "15m") return 60;
  return 365;
}

/**
 * Quick ranges scale with the timeframe so the default request always has enough
 * bars behind it, and never more than one request can carry.
 */
function rangeOptions(timeframe: string): Array<{ id: string; days: number }> {
  if (timeframe === "1m") return [{ id: "3d", days: 3 }, { id: "7d", days: 7 }, { id: "30d", days: 30 }];
  if (timeframe === "15m") return [{ id: "30d", days: 30 }, { id: "60d", days: 60 }, { id: "90d", days: 90 }];
  if (timeframe === "1h") return [{ id: "90d", days: 90 }, { id: "180d", days: 180 }, { id: "365d", days: 365 }];
  return [{ id: "90d", days: 90 }, { id: "365d", days: 365 }, { id: "1095d", days: 1095 }];
}

export default function BacktestWorkspace({
  locale, step, strategyId, strategyName, asset, market, timeframe, initialResult = null,
}: Props) {
  const messages = getMessages(locale);
  const copy = messages.backtest;
  const lab = messages.optimize;
  const tag = LOCALE_TAG[locale];
  const router = useRouter();

  const money = (value: number) =>
    new Intl.NumberFormat(tag, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
  const localTime = (value: number | string) =>
    new Intl.DateTimeFormat(tag, { month: "2-digit", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
  const localDate = (value: number | string) =>
    new Intl.DateTimeFormat(tag, { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));

  function parameterValue(value: number, unit: OptimizationParameter["unit"]): string {
    if (unit === "ratio") return `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
    if (unit === "quote") return money(value);
    if (unit === "bars") return lab.parameterBars(String(Math.round(value)));
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(5)));
  }

  function historyVerdict(result: BacktestResult): { title: string; detail: string; tone: "positive" | "caution" | "negative" } {
    const { metrics } = result;
    if (metrics.tradeCount === 0) return { ...copy.verdictNoTrades, tone: "caution" };
    if (metrics.netReturn > 0 && metrics.maximumDrawdown >= -0.15) {
      return { ...copy.verdictHealthy(percent(metrics.maximumDrawdown), metrics.tradeCount), tone: "positive" };
    }
    if (metrics.netReturn > 0) {
      return { ...copy.verdictVolatileGain(percent(metrics.maximumDrawdown)), tone: "caution" };
    }
    return { ...copy.verdictLoss(percent(metrics.buyAndHoldReturn)), tone: "negative" };
  }

  const ranges = rangeOptions(timeframe);
  const [activeStrategyId, setActiveStrategyId] = useState(strategyId);
  const [activeStrategyName, setActiveStrategyName] = useState(strategyName);
  const [yesterday] = useState(() => Date.now() - 24 * 60 * 60 * 1000);
  const [startDate, setStartDate] = useState(() =>
    initialResult ? dateInput(new Date(initialResult.startedAt).getTime()) : dateInput(yesterday - defaultDays(timeframe) * 24 * 60 * 60 * 1000));
  const [endDate, setEndDate] = useState(() =>
    initialResult ? dateInput(new Date(initialResult.endedAt).getTime()) : dateInput(yesterday));
  const [rangeId, setRangeId] = useState(() => ranges.find((range) => range.days === defaultDays(timeframe))?.id ?? "custom");
  const [initialCapital, setInitialCapital] = useState(() => String(initialResult?.config.initialCapital ?? 10000));
  const [feeBps, setFeeBps] = useState(() => String((initialResult?.config.takerFeeRate ?? 0.00045) * 10_000));
  const [slippageBps, setSlippageBps] = useState(() => String(initialResult?.config.slippageBps ?? 2));
  const [maxLeverage, setMaxLeverage] = useState(() => String(initialResult?.config.maxLeverage ?? 3));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<BacktestResult | null>(initialResult);
  const [parameterDrafts, setParameterDrafts] = useState<ParameterDraft[]>(() =>
    (initialResult?.optimization.parameters ?? []).map((parameter, index) => ({
      ...parameter,
      selected: index < Math.min(2, initialResult!.optimization.parameters.length),
      min: parameter.suggestedMin,
      max: parameter.suggestedMax,
      steps: parameter.suggestedSteps,
    })));
  const [optimizationLoading, setOptimizationLoading] = useState(false);
  const [optimizationError, setOptimizationError] = useState("");
  const [optimizationResult, setOptimizationResult] = useState<OptimizationResult | null>(null);
  const [objective, setObjective] = useState<OptimizationResult["objective"]>("balanced");
  const [blindLoading, setBlindLoading] = useState(false);
  const [blindResult, setBlindResult] = useState<BlindTestResult | null>(null);
  const [adoptLoading, setAdoptLoading] = useState(false);
  const [adoptedVersion, setAdoptedVersion] = useState<AdoptedVersion | null>(null);
  const lastRequestKey = useRef("");

  const describeFailure = (payload: ApiErrorPayload, fallback: string): string =>
    describeApiFailure(messages, payload, fallback);

  function requestConfig() {
    return {
      strategyId: activeStrategyId,
      startTime: new Date(`${startDate}T00:00:00Z`).getTime(),
      endTime: new Date(`${endDate}T23:59:59Z`).getTime(),
      initialCapital: Number(initialCapital),
      takerFeeRate: Number(feeBps) / 10_000,
      slippageBps: Number(slippageBps),
      maxLeverage: Number(maxLeverage),
    };
  }

  function applyRange(range: { id: string; days: number }) {
    setRangeId(range.id);
    setEndDate(dateInput(yesterday));
    setStartDate(dateInput(yesterday - range.days * 24 * 60 * 60 * 1000));
  }

  async function runBacktest() {
    if (loading) return;
    const requestBody = requestConfig();
    const requestKey = JSON.stringify(requestBody);
    if (result && lastRequestKey.current === requestKey) {
      document.getElementById("backtest-results")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/backtest/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const payload = await response.json() as BacktestResult & { code?: string; params?: Record<string, string | number> };
      if (!response.ok) throw new Error(describeFailure(payload, messages.errors.BACKTEST_FAILED));
      setResult(payload);
      setParameterDrafts(payload.optimization.parameters.map((parameter, index) => ({
        ...parameter,
        selected: index < Math.min(2, payload.optimization.parameters.length),
        min: parameter.suggestedMin,
        max: parameter.suggestedMax,
        steps: parameter.suggestedSteps,
      })));
      setOptimizationResult(null);
      setBlindResult(null);
      setAdoptedVersion(null);
      setOptimizationError("");
      lastRequestKey.current = requestKey;
      window.setTimeout(() => document.getElementById("backtest-results")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : messages.errors.BACKTEST_FAILED);
    } finally {
      setLoading(false);
    }
  }

  function updateParameter(id: string, change: Partial<Pick<ParameterDraft, "selected" | "min" | "max" | "steps">>) {
    if (change.selected && parameterDrafts.filter((parameter) => parameter.selected).length >= 4) {
      setOptimizationError(lab.tooManyParameters);
      return;
    }
    setOptimizationError("");
    setParameterDrafts((current) => current.map((parameter) => parameter.id === id ? { ...parameter, ...change } : parameter));
  }

  async function runOptimization() {
    if (!result || optimizationLoading) return;
    const selected = parameterDrafts.filter((parameter) => parameter.selected);
    if (selected.length === 0) {
      setOptimizationError(lab.noneSelected);
      return;
    }
    setOptimizationLoading(true);
    setOptimizationError("");
    try {
      const response = await fetch("/api/optimization/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...requestConfig(),
          objective,
          maxTrials: 12,
          parameters: selected.map((parameter) => ({ id: parameter.id, min: parameter.min, max: parameter.max, steps: parameter.steps })),
        }),
      });
      const payload = await response.json() as OptimizationResult & { code?: string; params?: Record<string, string | number> };
      if (!response.ok) throw new Error(describeFailure(payload, messages.errors.OPTIMIZATION_FAILED));
      setOptimizationResult(payload);
      setBlindResult(payload.blindResult ?? null);
      window.setTimeout(() => document.getElementById("optimization-results")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    } catch (caught) {
      setOptimizationError(caught instanceof Error ? caught.message : messages.errors.OPTIMIZATION_FAILED);
    } finally {
      setOptimizationLoading(false);
    }
  }

  async function revealBlindTest() {
    if (!optimizationResult || blindLoading || !optimizationResult.robustness.preBlindPassed) return;
    setBlindLoading(true);
    setOptimizationError("");
    try {
      const response = await fetch("/api/optimization/blind", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ optimizationId: optimizationResult.id }),
      });
      const payload = await response.json() as BlindTestResult & { code?: string };
      if (!response.ok) throw new Error(describeFailure(payload, messages.errors.BLIND_FAILED));
      setBlindResult(payload);
    } catch (caught) {
      setOptimizationError(caught instanceof Error ? caught.message : messages.errors.BLIND_FAILED);
    } finally {
      setBlindLoading(false);
    }
  }

  async function adoptOptimizedVersion() {
    if (!optimizationResult || !blindResult?.canCreateVersion || adoptLoading) return;
    setAdoptLoading(true);
    setOptimizationError("");
    try {
      const response = await fetch("/api/optimization/adopt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ optimizationId: optimizationResult.id }),
      });
      const payload = await response.json() as AdoptedVersion & { code?: string };
      if (!response.ok || !payload.id) throw new Error(describeFailure(payload, messages.errors.ADOPT_FAILED));
      setAdoptedVersion(payload);
      setActiveStrategyId(payload.id);
      if (payload.strategyName) setActiveStrategyName(payload.strategyName);
      router.refresh();
    } catch (caught) {
      setOptimizationError(caught instanceof Error ? caught.message : messages.errors.ADOPT_FAILED);
    } finally {
      setAdoptLoading(false);
    }
  }

  const baselineTrial = optimizationResult?.trials.find((trial) => trial.id === optimizationResult.baselineTrialId) ?? null;
  const recommendedTrial = optimizationResult?.trials.find((trial) => trial.id === optimizationResult.recommendedTrialId) ?? null;
  const returnValues = optimizationResult?.trials.map((trial) => trial.validation.netReturn) ?? [];
  const drawdownValues = optimizationResult?.trials.map((trial) => trial.validation.maximumDrawdown) ?? [];
  const minReturn = returnValues.length ? Math.min(...returnValues) : 0;
  const maxReturn = returnValues.length ? Math.max(...returnValues) : 1;
  const minDrawdown = drawdownValues.length ? Math.min(...drawdownValues) : -1;
  const maxDrawdown = drawdownValues.length ? Math.max(...drawdownValues) : 0;
  const verdict = result ? historyVerdict(result) : null;
  const selectedParameterCount = parameterDrafts.filter((parameter) => parameter.selected).length;
  const beatsBuyAndHold = result ? result.metrics.netReturn > result.metrics.buyAndHoldReturn : false;

  /* ---------------------------------------------------------------- step 3 */

  if (step === "backtest") {
    return (
      <section className="step-section backtest-section shell" id="main">
        <header className="step-head">
          <p className="step-badge">{copy.badge}</p>
          <h2>{copy.title}<br /><em>{copy.titleEmphasis}</em></h2>
          <p>{copy.lede}</p>
          <p className="step-why">{copy.whyThisStep}</p>
        </header>

        <div className="locked-strategy">
          <span>{copy.lockedLabel}</span>
          <strong>{activeStrategyName}</strong>
          <small>{copy.lockedMeta(asset, market, timeframe)}</small>
        </div>

        <div className="backtest-config">
          <div className="config-question">
            <strong>{copy.rangeQuestion}</strong>
            <span>{copy.rangeHint}</span>
          </div>
          <div className="range-chips" role="group" aria-label={copy.rangeGroupLabel}>
            {ranges.map((range) => (
              <button key={range.id} className={rangeId === range.id ? "active" : ""} onClick={() => applyRange(range)}>
                {copy.ranges[range.id] ?? range.id}
              </button>
            ))}
          </div>
          <div className="date-row">
            <label>{copy.startDate}<input type="date" value={startDate} max={endDate} onChange={(event) => { setRangeId("custom"); setStartDate(event.target.value); }} /></label>
            <label>{copy.endDate}<input type="date" value={endDate} min={startDate} max={dateInput(yesterday)} onChange={(event) => { setRangeId("custom"); setEndDate(event.target.value); }} /></label>
          </div>
          <button className="primary-action run-backtest" onClick={runBacktest} disabled={loading || !startDate || !endDate}>
            <span>{loading ? copy.running : result ? copy.rerun : copy.run}</span>
            <b>{loading ? <i className="spinner" /> : "▶"}</b>
          </button>
          <details className="advanced-settings">
            <summary>
              {copy.advanced}
              <small>{copy.advancedSummary(money(Number(initialCapital) || 0), feeBps, slippageBps, maxLeverage)}</small>
            </summary>
            <div>
              <label>{copy.initialCapital}<input type="number" min="100" step="100" value={initialCapital} onChange={(event) => setInitialCapital(event.target.value)} /></label>
              <label>{copy.feeBps}<input type="number" min="0" max="100" step="0.1" value={feeBps} onChange={(event) => setFeeBps(event.target.value)} /></label>
              <label>{copy.slippageBps}<input type="number" min="0" max="100" step="0.1" value={slippageBps} onChange={(event) => setSlippageBps(event.target.value)} /></label>
              <label>{copy.maxLeverage}<select value={maxLeverage} onChange={(event) => setMaxLeverage(event.target.value)}>
                {["1", "2", "3", "5", "10"].map((option) => <option key={option} value={option}>{option}×</option>)}
              </select></label>
            </div>
          </details>
        </div>

        <details className="execution-details">
          <summary>{copy.executionSummary}</summary>
          <div className="execution-note">
            {copy.executionSteps.map((note, index) => (
              <span key={note}><b>{String(index + 1).padStart(2, "0")}</b> {note}</span>
            ))}
          </div>
        </details>

        {error && <div className="alert error" role="alert"><strong>{copy.stoppedTitle}</strong><span>{error}</span></div>}
        {loading && (
          <div className="backtest-loading" role="status">
            <div className="scan-line" />
            <p>{copy.loadingReading(timeframe)}</p>
            <strong>{copy.loadingBody}</strong>
          </div>
        )}

        {result && !loading && (
          <div className="backtest-results" id="backtest-results">
            {verdict && (
              <div className={`verdict-card ${verdict.tone}`}>
                <div className="verdict-copy">
                  <span>{copy.verdictLabel}</span>
                  <h3>{verdict.title}</h3>
                  <p>{verdict.detail}</p>
                </div>
                <div className="verdict-number">
                  <b>{percent(result.metrics.netReturn)}</b>
                  <small>{money(result.initialCapital)} → {money(result.finalEquity)}</small>
                </div>
              </div>
            )}

            {result.dataWarnings.map((warning) => (
              <div className="alert warning" key={warning}><strong>{copy.dataWarningTitle}</strong><span>{warning}</span></div>
            ))}

            <div className="metric-grid">
              <article className={result.metrics.netReturn >= 0 ? "positive" : "negative"}>
                <span>{copy.metricNetReturn}</span>
                <strong>{percent(result.metrics.netReturn)}</strong>
                <small>{copy.metricNetReturnHint}</small>
              </article>
              <article>
                <span>{copy.metricDrawdown}</span>
                <strong>{percent(result.metrics.maximumDrawdown)}</strong>
                <small>{copy.metricDrawdownHint}</small>
              </article>
              <article>
                <span>{copy.metricTrades}</span>
                <strong>{result.metrics.tradeCount}</strong>
                <small>{copy.metricTradesHint}</small>
              </article>
              <article className={beatsBuyAndHold ? "positive" : ""}>
                <span>{copy.metricBuyHold}</span>
                <strong>{percent(result.metrics.buyAndHoldReturn)}</strong>
                <small>{beatsBuyAndHold ? copy.metricBuyHoldBeat : copy.metricBuyHoldLost}</small>
              </article>
            </div>

            <details className="more-metrics">
              <summary>{copy.moreMetrics}</summary>
              <div className="metric-grid">
                <article><span>{copy.metricSharpe}</span><strong>{number(result.metrics.sharpe)}</strong><small>{copy.metricSharpeHint}</small></article>
                <article><span>{copy.metricWinRate}</span><strong>{percent(result.metrics.winRate)}</strong><small>{copy.metricWinRateHint(result.metrics.winningTrades, result.metrics.losingTrades)}</small></article>
                <article><span>{copy.metricProfitFactor}</span><strong>{number(result.metrics.profitFactor)}</strong><small>{copy.metricProfitFactorHint}</small></article>
                <article><span>{copy.metricCost}</span><strong>{money(result.metrics.fees + result.metrics.slippageCost)}</strong><small>{copy.metricCostHint}</small></article>
              </div>
            </details>

            {result.bars && result.bars.length > 0 && (
              <div className="chart-card">
                <div className="card-heading">
                  <div><span>{copy.chartEyebrow}</span><h3>{copy.chartTitle(result.asset, result.timeframe)}</h3></div>
                  <p>{copy.chartHint}</p>
                </div>
                <BacktestChart
                  key={result.id}
                  bars={result.bars}
                  trades={result.trades}
                  equityCurve={result.equityCurve ?? []}
                  indicators={result.indicators ?? []}
                  asset={result.asset}
                  initialCapital={result.initialCapital}
                  locale={locale}
                />
              </div>
            )}

            <details className="trade-ledger" open={result.trades.length > 0 && result.trades.length <= 12}>
              <summary>{copy.ledgerSummary(result.trades.length)}<small>{copy.ledgerHint}</small></summary>
              {result.trades.length === 0 ? (
                <div className="no-trades">
                  <strong>{copy.noTradesTitle}</strong>
                  <span>{copy.noTradesDetail}</span>
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{copy.tableIndex}</th><th>{copy.tableSide}</th><th>{copy.tableEntryTime}</th><th>{copy.tableExitTime}</th>
                        <th>{copy.tableEntryPrice}</th><th>{copy.tableExitPrice}</th><th>{copy.tableExitReason}</th><th>{copy.tableNetPnl}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.trades.slice().reverse().map((trade, reverseIndex) => (
                        <tr key={`${trade.entryTimestamp}-${trade.exitTimestamp}`}>
                          <td>{result.trades.length - reverseIndex}</td>
                          <td><span className={`side-badge ${trade.side}`}>{trade.side === "long" ? copy.sideLong : copy.sideShort}</span></td>
                          <td>{localTime(trade.entryTimestamp)}</td>
                          <td>{localTime(trade.exitTimestamp)}</td>
                          <td>{trade.entryPrice.toFixed(2)}</td>
                          <td>{trade.exitPrice.toFixed(2)}</td>
                          <td>{copy.exitReasons[trade.exitReason] ?? trade.exitReason}</td>
                          <td className={trade.netPnl >= 0 ? "pnl-positive" : "pnl-negative"}>{money(trade.netPnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </details>

            <div className="next-step">
              <div>
                <span>{copy.nextStepEyebrow}</span>
                <strong>{result.metrics.netReturn > 0 ? copy.nextStepTitleGood : copy.nextStepTitleBad}</strong>
                <p>{copy.nextStepDetail}</p>
              </div>
              <Link href={localePath(locale, `/s/${activeStrategyId}/optimize`)}>{copy.nextStepCta} →</Link>
            </div>

            <div className="method-strip">
              <strong>{copy.methodTitle}</strong>
              <span>{copy.methodBody}</span>
            </div>

            <details className="run-details">
              <summary>{copy.runDetails}</summary>
              <dl>
                <div><dt>{copy.runId}</dt><dd>{result.id.slice(0, 12)}</dd></div>
                <div><dt>{copy.runRange}</dt><dd>{copy.runRangeValue(localTime(result.startedAt), localTime(result.endedAt), result.barCount.toLocaleString(tag))}</dd></div>
                <div><dt>{copy.runSource}</dt><dd>{result.dataSource}</dd></div>
                <div><dt>{copy.runExecution}</dt><dd>{result.executionModel}</dd></div>
                <div><dt>{copy.runDuration}</dt><dd>{copy.runDurationValue(result.durationMs, result.performance.dataMs, result.performance.executionMs, result.performance.resultCache !== "miss")}</dd></div>
                <div><dt>{copy.runEngine}</dt><dd>{result.engineVersion}</dd></div>
              </dl>
            </details>
          </div>
        )}
      </section>
    );
  }

  /* ---------------------------------------------------------------- step 4 */

  return (
    <section className="step-section optimization-section shell" id="main">
      <header className="step-head">
        <p className="step-badge">{lab.badge}</p>
        <h2>{lab.title}<br /><em>{lab.titleEmphasis}</em></h2>
        <p>{lab.lede}</p>
        <p className="step-why">{lab.whyThisStep}</p>
      </header>

      <div className="locked-strategy">
        <span>{lab.lockLabel}</span>
        <strong>{activeStrategyName}</strong>
        <small>{lab.lockHint}</small>
      </div>

      {!result ? (
        <div className="lab-empty">
          <strong>{lab.needsBacktestTitle}</strong>
          <span>{lab.needsBacktestDetail}</span>
          <Link className="ghost-button" href={localePath(locale, `/s/${activeStrategyId}/backtest`)}>{lab.needsBacktestCta}</Link>
        </div>
      ) : (
        <section className="optimization-lab" id="robustness" aria-labelledby="optimization-title">
          <div className="semantic-lock" id="optimization-title">
            <span>{lab.lockLabel}</span>
            <strong>{lab.lockValue}</strong>
            <small>{lab.lockHint}</small>
          </div>

          {parameterDrafts.length === 0 ? (
            <div className="lab-empty">
              <strong>{lab.emptyTitle}</strong>
              <span>{lab.emptyDetail}</span>
            </div>
          ) : (
            <div className="lab-setup">
              <div className="objective-block">
                <p>{lab.objectiveQuestion}</p>
                <div className="objective-switch" role="group" aria-label={lab.objectiveGroupLabel}>
                  {(["balanced", "return", "drawdown"] as const).map((id) => (
                    <button key={id} className={objective === id ? "active" : ""} onClick={() => setObjective(id)}>
                      <strong>{lab.objectives[id].label}</strong><small>{lab.objectives[id].hint}</small>
                    </button>
                  ))}
                </div>
              </div>

              <details className="parameter-picker">
                <summary>{lab.parameterSummary(selectedParameterCount)}<small>{lab.parameterHint}</small></summary>
                <div className="parameter-grid">
                  {parameterDrafts.map((parameter) => (
                    <article className={parameter.selected ? "selected" : "locked"} key={parameter.id}>
                      <label className="parameter-toggle">
                        <input type="checkbox" checked={parameter.selected} onChange={(event) => updateParameter(parameter.id, { selected: event.target.checked })} />
                        <span><strong>{parameter.label}</strong><small>{parameter.selected ? lab.parameterAllowed : lab.parameterLocked}</small></span>
                        <b>{parameterValue(parameter.value, parameter.unit)}</b>
                      </label>
                      {parameter.selected && (
                        <div className="parameter-range">
                          <label>{lab.parameterFrom}<input aria-label={lab.parameterMinAria(parameter.label)} type="number" value={parameter.min} step="any" min={parameter.hardBounds.min} max={parameter.max} onChange={(event) => updateParameter(parameter.id, { min: Number(event.target.value) })} /></label>
                          <label>{lab.parameterTo}<input aria-label={lab.parameterMaxAria(parameter.label)} type="number" value={parameter.max} step="any" min={parameter.min} max={parameter.hardBounds.max} onChange={(event) => updateParameter(parameter.id, { max: Number(event.target.value) })} /></label>
                          <label>{lab.parameterSteps}<select aria-label={lab.parameterStepsAria(parameter.label)} value={parameter.steps} onChange={(event) => updateParameter(parameter.id, { steps: Number(event.target.value) })}>
                            {[3, 5, 7].map((option) => <option key={option} value={option}>{option}</option>)}
                          </select></label>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </details>

              <button className="primary-action lab-action" onClick={runOptimization} disabled={optimizationLoading}>
                <span>{optimizationLoading ? lab.running : lab.run}</span>
                <b>{optimizationLoading ? <i className="spinner" /> : "→"}</b>
              </button>
              <p className="lab-note">{lab.labNote}</p>
            </div>
          )}

          {optimizationError && <div className="alert error" role="alert">{optimizationError}</div>}
          {optimizationLoading && (
            <div className="lab-progress" role="status"><i /><span>{lab.progress}</span></div>
          )}

          {optimizationResult && baselineTrial && recommendedTrial && !optimizationLoading && (
            <div className="optimization-results" id="optimization-results">
              <div className={`verdict-card lab ${optimizationResult.robustness.preBlindPassed ? "positive" : "negative"}`}>
                <div className="verdict-copy">
                  <span>{lab.verdictLabel}</span>
                  <h3>{optimizationResult.robustness.preBlindPassed ? lab.verdictPassed : lab.verdictFailed}</h3>
                  <p>{optimizationResult.robustness.preBlindPassed ? lab.verdictPassedDetail : lab.verdictFailedDetail}</p>
                </div>
                <div className="verdict-number">
                  <b>{optimizationResult.robustness.preBlindPassed ? "✓" : "!"}</b>
                  <small>{lab.comparedCount(optimizationResult.trials.length)}</small>
                </div>
              </div>

              <div className="robustness-gates">
                <article className={optimizationResult.robustness.walkForward.passed ? "passed" : "failed"}>
                  <div className="gate-head">
                    <span>{lab.gateWalkForward}</span>
                    <b>{optimizationResult.robustness.walkForward.passed ? lab.gatePassed : lab.gateFailed}</b>
                  </div>
                  <strong>{lab.gateWalkForwardDetail(optimizationResult.robustness.walkForward.positiveFolds, optimizationResult.robustness.walkForward.folds.length)}</strong>
                  <div className="gate-strip">
                    {optimizationResult.robustness.walkForward.folds.map((fold) => (
                      <i className={fold.passed ? "passed" : "failed"} key={fold.id}
                        title={lab.foldTitle(localDate(fold.validationStart), localDate(fold.validationEnd), percent(fold.candidate.netReturn), percent(fold.baseline.netReturn))}>
                        {fold.id}<small>{percent(fold.candidate.netReturn)}</small>
                      </i>
                    ))}
                  </div>
                </article>
                <article className={optimizationResult.robustness.sensitivity.passed ? "passed" : "failed"}>
                  <div className="gate-head">
                    <span>{lab.gateSensitivity}</span>
                    <b>{optimizationResult.robustness.sensitivity.passed ? lab.gatePassed : lab.gateFailed}</b>
                  </div>
                  <strong>{lab.gateSensitivityDetail(optimizationResult.robustness.sensitivity.stablePoints, optimizationResult.robustness.sensitivity.totalPoints)}</strong>
                  <div className="gate-strip">
                    {optimizationResult.robustness.sensitivity.points.map((point) => (
                      <i className={point.passed ? "passed" : "failed"} key={`${point.parameterId}-${point.direction}`} title={`${point.parameterId} = ${point.value}`}>
                        {point.direction === "lower" ? lab.directionLower : lab.directionHigher}<small>{percent(point.metrics.netReturn)}</small>
                      </i>
                    ))}
                  </div>
                </article>
                <article className={optimizationResult.robustness.costStress.passed ? "passed" : "failed"}>
                  <div className="gate-head">
                    <span>{lab.gateCost}</span>
                    <b>{optimizationResult.robustness.costStress.passed ? lab.gatePassed : lab.gateFailed}</b>
                  </div>
                  <strong>{lab.gateCostDetail}</strong>
                  <div className="gate-strip">
                    {optimizationResult.robustness.costStress.points.map((point) => (
                      <i className={point.passed ? "passed" : "failed"} key={point.id}>{point.label}<small>{percent(point.metrics.netReturn)}</small></i>
                    ))}
                  </div>
                </article>
              </div>

              <div className="candidate-parameters">
                <span>{optimizationResult.outcome === "improved" ? lab.candidateImproved : lab.candidateKept}</span>
                <div>
                  {optimizationResult.parameterSchema.map((parameter) => {
                    const candidateValue = recommendedTrial.parameters[parameter.id] ?? parameter.value;
                    const changed = candidateValue !== parameter.value;
                    return (
                      <b className={changed ? "changed" : ""} key={parameter.id}>
                        {parameter.label}
                        <small>{parameterValue(parameter.value, parameter.unit)}{changed ? ` → ${parameterValue(candidateValue, parameter.unit)}` : lab.candidateUnchanged}</small>
                      </b>
                    );
                  })}
                </div>
              </div>

              <div className={`blind-vault ${optimizationResult.robustness.preBlindPassed ? "unlocked" : "locked"}`}>
                <div className="vault-heading">
                  <div>
                    <span>{lab.vaultEyebrow}</span>
                    <strong>{blindResult ? lab.vaultDone : lab.vaultPending}</strong>
                    <small>{lab.vaultNote}</small>
                  </div>
                  <b>{blindResult
                    ? (blindResult.status === "passed" ? lab.vaultStatusPassed : lab.vaultStatusFailed)
                    : optimizationResult.robustness.preBlindPassed ? lab.vaultStatusReady : lab.vaultStatusLocked}</b>
                </div>
                {!optimizationResult.robustness.preBlindPassed && (
                  <div className="gate-failures">{optimizationResult.robustness.failedChecks.map((check) => <span key={check}>× {check}</span>)}</div>
                )}
                {optimizationResult.robustness.preBlindPassed && !blindResult && (
                  <button className="primary-action" onClick={revealBlindTest} disabled={blindLoading}>
                    <span>{blindLoading ? lab.runningBlind : lab.runBlind}</span>
                    <b>{blindLoading ? <i className="spinner" /> : "→"}</b>
                  </button>
                )}
                {blindResult && (
                  <div className="blind-result">
                    <div className="blind-compare">
                      <article><span>{lab.blindBaseline}</span><strong>{percent(blindResult.baseline.netReturn)}</strong><small>{lab.blindDrawdown(percent(blindResult.baseline.maximumDrawdown))}</small></article>
                      <i>{lab.blindVersus}</i>
                      <article className="candidate"><span>{lab.blindCandidate}</span><strong>{percent(blindResult.candidate.netReturn)}</strong><small>{lab.blindDrawdown(percent(blindResult.candidate.maximumDrawdown))}</small></article>
                    </div>
                    <div className="blind-checks">
                      {blindResult.checks.map((check) => (
                        <span className={check.passed ? "passed" : "failed"} key={check.id}><b>{check.passed ? "✓" : "×"} {check.label}</b><small>{check.detail}</small></span>
                      ))}
                    </div>
                    {blindResult.canCreateVersion ? (
                      <button className="primary-action" onClick={adoptOptimizedVersion} disabled={adoptLoading || Boolean(adoptedVersion)}>
                        <span>{adoptedVersion ? lab.adopted : adoptLoading ? lab.adopting : lab.adopt}</span>
                        <b>{adoptedVersion ? "✓" : "→"}</b>
                      </button>
                    ) : (
                      <div className="alert error"><strong>{lab.rejectedTitle}</strong><span>{lab.rejectedDetail}</span></div>
                    )}
                    {adoptedVersion && (
                      <div className="version-created">
                        <div>
                          <span>{lab.versionEyebrow}</span>
                          <strong>{adoptedVersion.strategyName ?? lab.versionFallbackName}</strong>
                          <small>{lab.versionMeta(adoptedVersion.id.slice(0, 12))}</small>
                        </div>
                        <Link href={localePath(locale, `/s/${adoptedVersion.id}/backtest`)}>{lab.versionRerun}</Link>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <details className="research-details">
                <summary>{lab.researchSummary}</summary>
                <div className="research-body">
                  <div className="candidate-compare">
                    <article><span>{lab.baselineTrial(baselineTrial.id)}</span><strong>{percent(baselineTrial.validation.netReturn)}</strong><small>{lab.trialMeta(percent(baselineTrial.validation.maximumDrawdown), baselineTrial.validation.tradeCount)}</small></article>
                    <i>→</i>
                    <article className="recommended"><span>{lab.recommendedTrial(recommendedTrial.id)}</span><strong>{percent(recommendedTrial.validation.netReturn)}</strong><small>{lab.trialMeta(percent(recommendedTrial.validation.maximumDrawdown), recommendedTrial.validation.tradeCount)}</small></article>
                  </div>

                  <div className="evidence-grid">
                    <div className="pareto-card">
                      <div className="evidence-heading"><span>{lab.paretoEyebrow}</span><strong>{lab.paretoTitle}</strong></div>
                      <div className="pareto-plot" aria-label={lab.paretoAria}>
                        <span className="axis-y">{lab.axisY}</span><span className="axis-x">{lab.axisX}</span>
                        {optimizationResult.trials.map((trial) => {
                          const left = 6 + (trial.validation.netReturn - minReturn) / Math.max(0.000001, maxReturn - minReturn) * 86;
                          const top = 8 + (maxDrawdown - trial.validation.maximumDrawdown) / Math.max(0.000001, maxDrawdown - minDrawdown) * 78;
                          return (
                            <i key={trial.id}
                              className={`${trial.pareto ? "pareto" : ""} ${trial.id === recommendedTrial.id ? "winner" : ""} ${trial.isBaseline ? "baseline" : ""}`}
                              style={{ left: `${left}%`, top: `${top}%` }}
                              title={lab.trialTitle(trial.id, percent(trial.validation.netReturn), percent(trial.validation.maximumDrawdown))}>
                              <b>{trial.id}</b>
                            </i>
                          );
                        })}
                      </div>
                      <div className="plot-legend">
                        <span><i className="baseline" />{lab.legendBaseline}</span>
                        <span><i className="pareto" />{lab.legendPareto}</span>
                        <span><i className="winner" />{lab.legendWinner}</span>
                      </div>
                    </div>
                    <div className="split-card">
                      <div className="evidence-heading"><span>{lab.splitEyebrow}</span><strong>{lab.splitTitle}</strong></div>
                      <div className="split-bar">
                        <i style={{ width: "56%" }}>{lab.splitTrain(optimizationResult.split.trainBars.toLocaleString(tag))}</i>
                        <b style={{ width: "24%" }}>{lab.splitValidation(optimizationResult.split.validationBars.toLocaleString(tag))}</b>
                        <em style={{ width: "20%" }}>{lab.splitBlind(optimizationResult.split.blindBars.toLocaleString(tag))}</em>
                      </div>
                      <dl>
                        <div><dt>{lab.splitTrainRange}</dt><dd>{localTime(optimizationResult.split.trainStart)} — {localTime(optimizationResult.split.trainEnd)}</dd></div>
                        <div><dt>{lab.splitValidationRange}</dt><dd>{localTime(optimizationResult.split.validationStart)} — {localTime(optimizationResult.split.validationEnd)}</dd></div>
                        <div><dt>{lab.splitBlindRange}</dt><dd>{localTime(optimizationResult.split.blindStart)} — {localTime(optimizationResult.split.blindEnd)}</dd></div>
                      </dl>
                      <p>{optimizationResult.validationNote}</p>
                    </div>
                  </div>

                  <div className="regime-card">
                    <div className="evidence-heading"><span>{lab.regimeEyebrow}</span><strong>{lab.regimeTitle}</strong></div>
                    <div>
                      {optimizationResult.robustness.regimes.map((item) => (
                        <article key={item.regime}>
                          <span>{lab.regimes[item.regime] ?? item.regime}</span>
                          <strong>{money(item.netPnl)}</strong>
                          <small>{lab.regimeMeta(item.tradeCount, percent(item.winRate))}</small>
                        </article>
                      ))}
                    </div>
                    {optimizationResult.robustness.multiplicity.warning && (
                      <p>{lab.multiplicityNote(optimizationResult.robustness.multiplicity.warning, number(optimizationResult.robustness.multiplicity.selectionAdjustedSharpe))}</p>
                    )}
                  </div>

                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>{lab.tableTrial}</th><th>{lab.tableTrainReturn}</th><th>{lab.tableValidationReturn}</th><th>{lab.tableValidationDrawdown}</th>
                          <th>{lab.tableValidationSharpe}</th><th>{lab.tableWinRate}</th><th>{lab.tableTradeCount}</th><th>{lab.tableVerdict}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...optimizationResult.trials].sort((left, right) => right.score - left.score).map((trial) => (
                          <tr key={trial.id} className={trial.id === recommendedTrial.id ? "recommended-row" : ""}>
                            <td>{trial.id}{trial.isBaseline ? lab.tableBaselineSuffix : ""}</td>
                            <td>{percent(trial.train.netReturn)}</td>
                            <td>{percent(trial.validation.netReturn)}</td>
                            <td>{percent(trial.validation.maximumDrawdown)}</td>
                            <td>{number(trial.validation.sharpe)}</td>
                            <td>{percent(trial.validation.winRate)}</td>
                            <td>{trial.validation.tradeCount}</td>
                            <td>{trial.id === recommendedTrial.id ? lab.verdictRecommended : trial.pareto ? lab.verdictPareto : lab.verdictDropped}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <p className="side-note">{lab.experimentNote(optimizationResult.id.slice(0, 12), optimizationResult.durationMs, optimizationResult.resultCache !== "miss")}</p>
                </div>
              </details>
            </div>
          )}
        </section>
      )}

      <div className="method-strip">
        <strong>{copy.methodTitle}</strong>
        <span>{copy.methodBody}</span>
      </div>
    </section>
  );
}
