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
  position: RuntimePosition;
  equity: number;
  state: StrategyState;
}

export interface SandboxLimits {
  timeoutMs: number;
  memoryLimitBytes: number;
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
const __bars = [];
const __emaCaches = Object.create(null);

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

function __invoke(inputJson) {
  const __input = JSON.parse(inputJson);
  __appendBars(__input.bars);
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
    indicators: Object.freeze({ sma: __sma, ema: __ema, highest: __highest, lowest: __lowest, percentChange: __percentChange }),
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
`;
}

export class StrategySandboxSession {
  private historyLength = 0;
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
    return this.invoke(newBars, invocation.position, invocation.equity, invocation.state);
  }

  async runBar(
    bar: MarketBar,
    position: RuntimePosition,
    equity: number,
    state: StrategyState,
  ): Promise<StrategyProgramResult> {
    if (this.disposed) throw new Error("Strategy sandbox session has been disposed.");
    return this.invoke([bar], position, equity, state);
  }

  private invoke(
    bars: MarketBar[],
    position: RuntimePosition,
    equity: number,
    state: StrategyState,
  ): StrategyProgramResult {
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.limits.timeoutMs));
    const payload = JSON.stringify({ bars, position, equity, state });
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
