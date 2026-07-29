import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSRuntime,
} from "quickjs-emscripten";

import { compileStrategySource, type CompiledStrategyProgram } from "../compiler/compile-strategy-source.js";
import type {
  JsonValue,
  MarketBar,
  RuntimePosition,
  StrategyDecision,
  StrategyProgramResult,
  StrategyState,
} from "../core/types.js";

export interface StrategyInvocation {
  bars: MarketBar[];
  timeframes?: Partial<Record<"1m" | "15m" | "1h" | "4h", MarketBar[]>>;
  position: RuntimePosition;
  equity: number;
  state: StrategyState;
}

export interface SandboxLimits {
  timeoutMs: number;
  memoryLimitBytes: number;
}

export interface StrategySemanticScenario {
  market?: Partial<MarketBar>;
  position?: Partial<RuntimePosition>;
  equity?: number;
  state?: StrategyState;
  indicators?: Record<string, JsonValue>;
  timeframes?: Partial<Record<"1m" | "15m" | "1h" | "4h", {
    market?: Partial<MarketBar>;
    indicators?: Record<string, JsonValue>;
  }>>;
}

const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: 100,
  memoryLimitBytes: 8 * 1024 * 1024,
};

function assertFiniteNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number.`);
}

function assertDecision(value: unknown): asserts value is StrategyDecision {
  if (!value || typeof value !== "object" || !("type" in value)) {
    throw new Error("Strategy onBar must return a decision object.");
  }
  const decision = value as Record<string, unknown>;
  if (decision.type === "hold" || decision.type === "close") return;
  if (decision.type !== "open") throw new Error(`Unsupported strategy decision '${String(decision.type)}'.`);
  if (decision.side !== "long" && decision.side !== "short") throw new Error("Open decision side must be 'long' or 'short'.");
  if (!decision.size || typeof decision.size !== "object") throw new Error("Open decision requires a size object.");
  const size = decision.size as Record<string, unknown>;
  if (size.kind !== "riskPercent" && size.kind !== "fixedNotional") {
    throw new Error("Size kind must be riskPercent or fixedNotional.");
  }
  assertFiniteNumber(size.value, "size.value");
  if (size.value <= 0) throw new Error("size.value must be greater than zero.");
  assertFiniteNumber(decision.stopLossPercent, "stopLossPercent");
  if (decision.stopLossPercent <= 0 || decision.stopLossPercent >= 1) {
    throw new Error("stopLossPercent must be between zero and one.");
  }
  if (decision.takeProfitRiskReward !== undefined) {
    assertFiniteNumber(decision.takeProfitRiskReward, "takeProfitRiskReward");
    if (decision.takeProfitRiskReward <= 0) throw new Error("takeProfitRiskReward must be greater than zero.");
  }
}

function assertJsonValue(value: unknown, path = "state"): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`);
    return;
  }
  throw new Error(`${path} must contain JSON-serializable values only.`);
}

function parseSandboxResult(raw: string, program: CompiledStrategyProgram): StrategyProgramResult {
  const result = JSON.parse(raw) as unknown;
  if (!result || typeof result !== "object") throw new Error("Strategy sandbox returned malformed JSON.");
  const candidate = result as Record<string, unknown>;
  const strategy = candidate.strategy;
  if (!strategy || typeof strategy !== "object") throw new Error("Strategy metadata is missing.");
  const metadata = strategy as Record<string, unknown>;
  if (typeof metadata.id !== "string" || typeof metadata.name !== "string" || !Number.isInteger(metadata.version)) {
    throw new Error("Strategy metadata must include string id/name and integer version.");
  }
  assertDecision(candidate.decision);
  assertJsonValue(candidate.state);
  if (!candidate.state || Array.isArray(candidate.state) || typeof candidate.state !== "object") {
    throw new Error("Strategy state must be an object.");
  }
  return {
    strategy: {
      id: metadata.id,
      name: metadata.name,
      version: metadata.version as number,
      programHash: program.sourceHash,
    },
    decision: candidate.decision,
    state: candidate.state as StrategyState,
  };
}

function makeSandboxBootstrap(program: CompiledStrategyProgram): string {
  return `
"use strict";
globalThis.eval = undefined;
globalThis.Function = undefined;
globalThis.Date = undefined;
globalThis.performance = undefined;
globalThis.crypto = undefined;
globalThis.WebAssembly = undefined;
globalThis.fetch = undefined;

const defineStrategy = (definition) => definition;
const __strategy = (${program.javascript});
const __frameBars = Object.create(null);
const __frameEmaCaches = Object.create(null);
__frameBars.current = [];
__frameEmaCaches.current = Object.create(null);
let __bars = __frameBars.current;
let __emaCaches = __frameEmaCaches.current;

function __withFrame(key, callback) {
  const previousBars = __bars;
  const previousCaches = __emaCaches;
  __frameBars[key] ??= [];
  __frameEmaCaches[key] ??= Object.create(null);
  __bars = __frameBars[key];
  __emaCaches = __frameEmaCaches[key];
  try {
    return callback();
  } finally {
    __bars = previousBars;
    __emaCaches = previousCaches;
  }
}

function __value(field, offset = 0) {
  const index = __bars.length - 1 - offset;
  if (index < 0) return null;
  const value = __bars[index][field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function __window(field, period, offset = 0) {
  if (!Number.isInteger(period) || period <= 0 || !Number.isInteger(offset) || offset < 0) return null;
  const end = __bars.length - offset;
  const start = end - period;
  if (start < 0) return null;
  const values = [];
  for (let index = start; index < end; index += 1) {
    const value = __bars[index][field];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    values.push(value);
  }
  return values;
}

function __advanceEma(cache, index) {
  const current = __bars[index][cache.field];
  if (typeof current !== "number" || !Number.isFinite(current)) {
    cache.values.push(null);
    return;
  }
  if (index + 1 < cache.period) {
    cache.values.push(null);
    return;
  }
  if (index + 1 === cache.period) {
    let sum = 0;
    for (let cursor = 0; cursor < cache.period; cursor += 1) {
      const value = __bars[cursor][cache.field];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        cache.values.push(null);
        return;
      }
      sum += value;
    }
    cache.values.push(sum / cache.period);
    return;
  }
  const previous = cache.values[index - 1];
  cache.values.push(typeof previous === "number" ? cache.alpha * current + (1 - cache.alpha) * previous : null);
}

function __appendBars(rows) {
  for (const row of rows) {
    __bars.push(Object.freeze(row));
    const index = __bars.length - 1;
    for (const key of Object.keys(__emaCaches)) __advanceEma(__emaCaches[key], index);
  }
}

function __appendTimeframes(timeframes) {
  for (const key of Object.keys(timeframes ?? {})) {
    __withFrame(key, () => __appendBars(timeframes[key]));
  }
}

function __sma(field, period, offset = 0) {
  const values = __window(field, period, offset);
  return values ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function __ema(field, period, offset = 0) {
  if (!Number.isInteger(period) || period <= 0 || !Number.isInteger(offset) || offset < 0) return null;
  const key = field + ":" + period;
  let cache = __emaCaches[key];
  if (!cache) {
    cache = { field, period, alpha: 2 / (period + 1), values: [] };
    __emaCaches[key] = cache;
    for (let index = 0; index < __bars.length; index += 1) __advanceEma(cache, index);
  }
  const index = cache.values.length - 1 - offset;
  return index >= 0 ? cache.values[index] : null;
}

function __highest(field, period, offset = 0) {
  const values = __window(field, period, offset);
  return values ? Math.max(...values) : null;
}

function __lowest(field, period, offset = 0) {
  const values = __window(field, period, offset);
  return values ? Math.min(...values) : null;
}

function __percentChange(field, periods) {
  const current = __value(field, 0);
  const previous = __value(field, periods);
  return current === null || previous === null || previous === 0 ? null : current / previous - 1;
}

function __standardDeviation(field, period, offset = 0) {
  const values = __window(field, period, offset);
  if (!values) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function __rsi(field, period, offset = 0) {
  if (!Number.isInteger(period) || period <= 0 || !Number.isInteger(offset) || offset < 0) return null;
  const end = __bars.length - offset;
  if (end < period + 1) return null;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = __bars[index][field] - __bars[index - 1][field];
    averageGain += Math.max(0, change) / period;
    averageLoss += Math.max(0, -change) / period;
  }
  for (let index = period + 1; index < end; index += 1) {
    const change = __bars[index][field] - __bars[index - 1][field];
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function __trueRange(index) {
  const bar = __bars[index];
  if (!bar) return null;
  if (index === 0) return bar.high - bar.low;
  const previousClose = __bars[index - 1].close;
  return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
}

function __atr(period, offset = 0) {
  if (!Number.isInteger(period) || period <= 0 || !Number.isInteger(offset) || offset < 0) return null;
  const end = __bars.length - offset;
  if (end < period) return null;
  let value = 0;
  for (let index = 0; index < period; index += 1) value += __trueRange(index) / period;
  for (let index = period; index < end; index += 1) value = (value * (period - 1) + __trueRange(index)) / period;
  return value;
}

function __emaSeries(field, period) {
  const key = field + ":" + period;
  let cache = __emaCaches[key];
  if (!cache) {
    cache = { field, period, alpha: 2 / (period + 1), values: [] };
    __emaCaches[key] = cache;
    for (let index = 0; index < __bars.length; index += 1) __advanceEma(cache, index);
  }
  return cache.values;
}

function __macd(field, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9, offset = 0) {
  if (![fastPeriod, slowPeriod, signalPeriod].every(value => Number.isInteger(value) && value > 0) || fastPeriod >= slowPeriod) return null;
  const target = __bars.length - 1 - offset;
  const fast = __emaSeries(field, fastPeriod);
  const slow = __emaSeries(field, slowPeriod);
  const macdValues = [];
  for (let index = 0; index <= target; index += 1) {
    macdValues.push(typeof fast[index] === "number" && typeof slow[index] === "number" ? fast[index] - slow[index] : null);
  }
  const available = macdValues.filter(value => typeof value === "number");
  if (available.length < signalPeriod) return null;
  const alpha = 2 / (signalPeriod + 1);
  let signal = available.slice(0, signalPeriod).reduce((sum, value) => sum + value, 0) / signalPeriod;
  for (let index = signalPeriod; index < available.length; index += 1) signal = alpha * available[index] + (1 - alpha) * signal;
  const macd = macdValues[target];
  return typeof macd === "number" ? { macd, signal, histogram: macd - signal } : null;
}

function __bollingerBands(field, period, standardDeviations = 2, offset = 0) {
  const middle = __sma(field, period, offset);
  const deviation = __standardDeviation(field, period, offset);
  if (middle === null || deviation === null || !Number.isFinite(standardDeviations) || standardDeviations <= 0) return null;
  return { middle, upper: middle + standardDeviations * deviation, lower: middle - standardDeviations * deviation };
}

function __historyValues(field, period, offset = 0) {
  return __window(field, period, offset);
}

function __historyBars(period, offset = 0) {
  if (!Number.isInteger(period) || period <= 0 || !Number.isInteger(offset) || offset < 0) return null;
  const end = __bars.length - offset;
  const start = end - period;
  if (start < 0) return null;
  return __bars.slice(start, end).map(bar => Object.freeze({
    timestamp: bar.timestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    markPrice: bar.markPrice ?? bar.close,
    fundingRate: bar.fundingRate ?? 0,
    openInterest: bar.openInterest ?? null
  }));
}

function __dataView(key) {
  const bars = __frameBars[key];
  if (!bars || bars.length === 0) return null;
  const latest = bars[bars.length - 1];
  const call = (fn, args) => __withFrame(key, () => fn(...args));
  return Object.freeze({
    market: Object.freeze({
      timestamp: latest.timestamp,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      close: latest.close,
      volume: latest.volume,
      markPrice: latest.markPrice ?? latest.close,
      fundingRate: latest.fundingRate ?? 0,
      openInterest: latest.openInterest ?? null
    }),
    indicators: Object.freeze({
      sma: (...args) => call(__sma, args),
      ema: (...args) => call(__ema, args),
      highest: (...args) => call(__highest, args),
      lowest: (...args) => call(__lowest, args),
      percentChange: (...args) => call(__percentChange, args),
      standardDeviation: (...args) => call(__standardDeviation, args),
      rsi: (...args) => call(__rsi, args),
      atr: (...args) => call(__atr, args),
      macd: (...args) => call(__macd, args),
      bollingerBands: (...args) => call(__bollingerBands, args)
    }),
    history: Object.freeze({
      values: (...args) => call(__historyValues, args),
      bars: (...args) => call(__historyBars, args)
    })
  });
}

function __invoke(inputJson) {
  const __input = JSON.parse(inputJson);
  __appendBars(__input.bars);
  __appendTimeframes(__input.timeframes);
  const __state = JSON.parse(JSON.stringify(__input.state));
  const __bar = __bars[__bars.length - 1];
  const __context = Object.freeze({
    market: Object.freeze({
      timestamp: __bar.timestamp,
      open: __bar.open,
      high: __bar.high,
      low: __bar.low,
      close: __bar.close,
      volume: __bar.volume,
      markPrice: __bar.markPrice ?? __bar.close,
      fundingRate: __bar.fundingRate ?? 0,
      openInterest: __bar.openInterest ?? null
    }),
    account: Object.freeze({ equity: __input.equity }),
    position: Object.freeze(__input.position),
    indicators: Object.freeze({
      sma: __sma,
      ema: __ema,
      highest: __highest,
      lowest: __lowest,
      percentChange: __percentChange,
      standardDeviation: __standardDeviation,
      rsi: __rsi,
      atr: __atr,
      macd: __macd,
      bollingerBands: __bollingerBands
    }),
    history: Object.freeze({ values: __historyValues, bars: __historyBars }),
    timeframe: interval => __dataView(interval),
    state: Object.freeze({
      get: (key, fallback) => Object.prototype.hasOwnProperty.call(__state, key) ? __state[key] : fallback,
      set: (key, value) => { __state[key] = value; }
    }),
    crossedAbove: (currentA, previousA, currentB, previousB) =>
      [currentA, previousA, currentB, previousB].every(Number.isFinite) && previousA <= previousB && currentA > currentB,
    crossedBelow: (currentA, previousA, currentB, previousB) =>
      [currentA, previousA, currentB, previousB].every(Number.isFinite) && previousA >= previousB && currentA < currentB
  });
  const __decision = __strategy.onBar(__context) ?? { type: "hold" };
  return JSON.stringify({
    strategy: { id: __strategy.id, name: __strategy.name, version: __strategy.version },
    decision: __decision,
    state: __state
  });
}

function __invokeSemantic(inputJson) {
  const input = JSON.parse(inputJson);
  const state = JSON.parse(JSON.stringify(input.state ?? {}));
  const market = Object.freeze({
    timestamp: input.market?.timestamp ?? 0,
    open: input.market?.open ?? 100,
    high: input.market?.high ?? 101,
    low: input.market?.low ?? 99,
    close: input.market?.close ?? 100,
    volume: input.market?.volume ?? 1000,
    markPrice: input.market?.markPrice ?? input.market?.close ?? 100,
    fundingRate: input.market?.fundingRate ?? 0,
    openInterest: input.market?.openInterest ?? 1000000
  });
  const position = Object.freeze({
    side: input.position?.side ?? "flat",
    quantity: input.position?.quantity ?? 0,
    entryPrice: input.position?.entryPrice ?? null,
    stopPrice: input.position?.stopPrice ?? null,
    takeProfitPrice: input.position?.takeProfitPrice ?? null,
    unrealizedPnl: input.position?.unrealizedPnl ?? 0
  });
  const key = (name, args) => {
    const normalized = [...args];
    if (["sma", "ema", "highest", "lowest", "standardDeviation", "rsi"].includes(name) && normalized.length < 3) normalized.push(0);
    if (name === "atr" && normalized.length < 2) normalized.push(0);
    if (name === "macd") {
      const defaults = ["close", 12, 26, 9, 0];
      while (normalized.length < defaults.length) normalized.push(defaults[normalized.length]);
    }
    if (name === "bollingerBands") {
      const defaults = ["close", 20, 2, 0];
      while (normalized.length < defaults.length) normalized.push(defaults[normalized.length]);
    }
    return name + "(" + normalized.map(value => typeof value === "string" ? JSON.stringify(value) : String(value)).join(",") + ")";
  };
  const indicator = (values, name) => (...args) => values?.[key(name, args)] ?? null;
  const indicatorSet = values => Object.freeze({
    sma: indicator(values, "sma"), ema: indicator(values, "ema"), highest: indicator(values, "highest"), lowest: indicator(values, "lowest"),
    percentChange: indicator(values, "percentChange"), standardDeviation: indicator(values, "standardDeviation"),
    rsi: indicator(values, "rsi"), atr: indicator(values, "atr"), macd: indicator(values, "macd"), bollingerBands: indicator(values, "bollingerBands")
  });
  const semanticTimeframe = interval => {
    const frame = input.timeframes?.[interval];
    if (!frame) return null;
    const frameMarket = frame.market ?? {};
    return Object.freeze({
      market: Object.freeze({
        timestamp: frameMarket.timestamp ?? 0, open: frameMarket.open ?? 100, high: frameMarket.high ?? 101,
        low: frameMarket.low ?? 99, close: frameMarket.close ?? 100, volume: frameMarket.volume ?? 1000,
        markPrice: frameMarket.markPrice ?? frameMarket.close ?? 100, fundingRate: frameMarket.fundingRate ?? 0,
        openInterest: frameMarket.openInterest ?? 1000000
      }),
      indicators: indicatorSet(frame.indicators),
      history: Object.freeze({ values: () => null, bars: () => null })
    });
  };
  const context = Object.freeze({
    market,
    account: Object.freeze({ equity: input.equity ?? 10000 }),
    position,
    indicators: indicatorSet(input.indicators),
    history: Object.freeze({ values: () => null, bars: () => null }),
    timeframe: semanticTimeframe,
    state: Object.freeze({
      get: (name, fallback) => Object.prototype.hasOwnProperty.call(state, name) ? state[name] : fallback,
      set: (name, value) => { state[name] = value; }
    }),
    crossedAbove: (currentA, previousA, currentB, previousB) =>
      [currentA, previousA, currentB, previousB].every(Number.isFinite) && previousA <= previousB && currentA > currentB,
    crossedBelow: (currentA, previousA, currentB, previousB) =>
      [currentA, previousA, currentB, previousB].every(Number.isFinite) && previousA >= previousB && currentA < currentB
  });
  const decision = __strategy.onBar(context) ?? { type: "hold" };
  return JSON.stringify({
    strategy: { id: __strategy.id, name: __strategy.name, version: __strategy.version },
    decision,
    state
  });
}
`;
}

export class StrategySandboxSession {
  private historyLength = 0;
  private readonly timeframeHistoryLengths = new Map<string, number>();
  private disposed = false;

  private constructor(
    private readonly program: CompiledStrategyProgram,
    private readonly limits: SandboxLimits,
    private readonly runtime: QuickJSRuntime,
    private readonly context: QuickJSContext,
  ) {}

  static async create(
    program: CompiledStrategyProgram,
    limits: SandboxLimits = DEFAULT_LIMITS,
  ): Promise<StrategySandboxSession> {
    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(limits.memoryLimitBytes);
    runtime.setMaxStackSize(Math.min(512 * 1024, Math.floor(limits.memoryLimitBytes / 4)));
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.timeoutMs));
    const context = runtime.newContext();
    try {
      context.unwrapResult(context.evalCode(makeSandboxBootstrap(program))).dispose();
      return new StrategySandboxSession(program, limits, runtime, context);
    } catch (error) {
      context.dispose();
      runtime.dispose();
      throw error;
    }
  }

  async run(invocation: StrategyInvocation): Promise<StrategyProgramResult> {
    if (this.disposed) throw new Error("Strategy sandbox session has been disposed.");
    if (invocation.bars.length === 0) throw new Error("At least one market bar is required.");
    if (invocation.bars.length < this.historyLength) throw new Error("Strategy history cannot move backwards.");
    const newBars = invocation.bars.slice(this.historyLength);
    if (newBars.length === 0) throw new Error("Strategy invocation must append at least one new market bar.");
    const newTimeframes: Record<string, MarketBar[]> = {};
    for (const [interval, bars] of Object.entries(invocation.timeframes ?? {})) {
      const previousLength = this.timeframeHistoryLengths.get(interval) ?? 0;
      if (bars.length < previousLength) throw new Error(`Strategy ${interval} history cannot move backwards.`);
      const appended = bars.slice(previousLength);
      if (appended.length > 0) newTimeframes[interval] = appended;
    }
    const result = this.invoke(newBars, invocation.position, invocation.equity, invocation.state, newTimeframes);
    for (const [interval, bars] of Object.entries(invocation.timeframes ?? {})) {
      this.timeframeHistoryLengths.set(interval, bars.length);
    }
    return result;
  }

  async runBar(
    bar: MarketBar,
    position: RuntimePosition,
    equity: number,
    state: StrategyState,
    timeframes: Partial<Record<"1m" | "15m" | "1h" | "4h", MarketBar[]>> = {},
  ): Promise<StrategyProgramResult> {
    if (this.disposed) throw new Error("Strategy sandbox session has been disposed.");
    return this.invoke([bar], position, equity, state, timeframes);
  }

  async runSemanticScenario(scenario: StrategySemanticScenario): Promise<StrategyProgramResult> {
    if (this.disposed) throw new Error("Strategy sandbox session has been disposed.");
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.limits.timeoutMs));
    const source = `__invokeSemantic(${JSON.stringify(JSON.stringify(scenario))})`;
    const handle = this.context.unwrapResult(this.context.evalCode(source));
    try {
      return parseSandboxResult(this.context.getString(handle), this.program);
    } finally {
      handle.dispose();
    }
  }

  private invoke(
    bars: MarketBar[],
    position: RuntimePosition,
    equity: number,
    state: StrategyState,
    timeframes: Partial<Record<"1m" | "15m" | "1h" | "4h", MarketBar[]>> = {},
  ): StrategyProgramResult {
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.limits.timeoutMs));
    const payload = JSON.stringify({ bars, timeframes, position, equity, state });
    const source = `__invoke(${JSON.stringify(payload)})`;
    const handle = this.context.unwrapResult(this.context.evalCode(source));
    try {
      const raw = this.context.getString(handle);
      const result = parseSandboxResult(raw, this.program);
      this.historyLength += bars.length;
      return result;
    } finally {
      handle.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.context.dispose();
    this.runtime.dispose();
  }
}

export async function runStrategyProgram(
  source: string,
  invocation: StrategyInvocation,
  limits: SandboxLimits = DEFAULT_LIMITS,
): Promise<StrategyProgramResult> {
  return runCompiledStrategyProgram(compileStrategySource(source), invocation, limits);
}

export async function runCompiledStrategyProgram(
  program: CompiledStrategyProgram,
  invocation: StrategyInvocation,
  limits: SandboxLimits = DEFAULT_LIMITS,
): Promise<StrategyProgramResult> {
  const session = await StrategySandboxSession.create(program, limits);
  try {
    return await session.run(invocation);
  } finally {
    session.dispose();
  }
}
