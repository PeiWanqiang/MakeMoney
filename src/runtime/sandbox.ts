import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";

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
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
}

function assertDecision(value: unknown): asserts value is StrategyDecision {
  if (!value || typeof value !== "object" || !("type" in value)) {
    throw new Error("Strategy onBar must return a decision object.");
  }

  const decision = value as Record<string, unknown>;
  if (decision.type === "hold" || decision.type === "close") {
    return;
  }
  if (decision.type !== "open") {
    throw new Error(`Unsupported strategy decision '${String(decision.type)}'.`);
  }
  if (decision.side !== "long" && decision.side !== "short") {
    throw new Error("Open decision side must be 'long' or 'short'.");
  }
  if (!decision.size || typeof decision.size !== "object") {
    throw new Error("Open decision requires a size object.");
  }
  const size = decision.size as Record<string, unknown>;
  if (size.kind !== "riskPercent" && size.kind !== "fixedNotional") {
    throw new Error("Size kind must be riskPercent or fixedNotional.");
  }
  assertFiniteNumber(size.value, "size.value");
  if (size.value <= 0) {
    throw new Error("size.value must be greater than zero.");
  }
  assertFiniteNumber(decision.stopLossPercent, "stopLossPercent");
  if (decision.stopLossPercent <= 0 || decision.stopLossPercent >= 1) {
    throw new Error("stopLossPercent must be between zero and one.");
  }
  if (decision.takeProfitRiskReward !== undefined) {
    assertFiniteNumber(decision.takeProfitRiskReward, "takeProfitRiskReward");
    if (decision.takeProfitRiskReward <= 0) {
      throw new Error("takeProfitRiskReward must be greater than zero.");
    }
  }
}

function assertJsonValue(value: unknown, path = "state"): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} contains a non-finite number.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} must contain JSON-serializable values only.`);
}

function makeSandboxScript(program: CompiledStrategyProgram, invocation: StrategyInvocation): string {
  const input = JSON.stringify(invocation).replaceAll("<", "\\u003c");

  return `
"use strict";
globalThis.eval = undefined;
globalThis.Function = undefined;
globalThis.Date = undefined;
globalThis.performance = undefined;
globalThis.crypto = undefined;
globalThis.WebAssembly = undefined;
globalThis.fetch = undefined;

const __input = ${input};
const __state = JSON.parse(JSON.stringify(__input.state));
const defineStrategy = (definition) => definition;
const __strategy = (${program.javascript});

function __value(field, offset = 0) {
  const index = __input.bars.length - 1 - offset;
  if (index < 0) return null;
  const value = __input.bars[index][field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function __window(field, period, offset = 0) {
  if (!Number.isInteger(period) || period <= 0 || !Number.isInteger(offset) || offset < 0) return null;
  const end = __input.bars.length - offset;
  const start = end - period;
  if (start < 0) return null;
  const values = [];
  for (let index = start; index < end; index += 1) {
    const value = __input.bars[index][field];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    values.push(value);
  }
  return values;
}

function __sma(field, period, offset = 0) {
  const values = __window(field, period, offset);
  if (!values) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function __ema(field, period, offset = 0) {
  if (!Number.isInteger(period) || period <= 0 || !Number.isInteger(offset) || offset < 0) return null;
  const end = __input.bars.length - offset;
  if (end < period) return null;
  const alpha = 2 / (period + 1);
  let value = 0;
  for (let index = 0; index < period; index += 1) value += __input.bars[index][field];
  value /= period;
  for (let index = period; index < end; index += 1) {
    value = alpha * __input.bars[index][field] + (1 - alpha) * value;
  }
  return value;
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
  if (current === null || previous === null || previous === 0) return null;
  return current / previous - 1;
}

const __bar = __input.bars[__input.bars.length - 1];
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
    percentChange: __percentChange
  }),
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
JSON.stringify({
  strategy: { id: __strategy.id, name: __strategy.name, version: __strategy.version },
  decision: __decision,
  state: __state
});
`;
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
  if (invocation.bars.length === 0) {
    throw new Error("At least one market bar is required.");
  }

  const QuickJS = await getQuickJS();
  const raw = QuickJS.evalCode(makeSandboxScript(program, invocation), {
    memoryLimitBytes: limits.memoryLimitBytes,
    shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + limits.timeoutMs),
  });

  if (typeof raw !== "string") {
    throw new Error("Strategy sandbox returned an invalid result.");
  }

  const result = JSON.parse(raw) as unknown;
  if (!result || typeof result !== "object") {
    throw new Error("Strategy sandbox returned malformed JSON.");
  }

  const candidate = result as Record<string, unknown>;
  const strategy = candidate.strategy;
  if (!strategy || typeof strategy !== "object") {
    throw new Error("Strategy metadata is missing.");
  }
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
