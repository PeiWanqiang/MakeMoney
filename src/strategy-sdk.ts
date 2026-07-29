import type { JsonValue, StrategyDecision } from "./core/types.js";

export interface StrategyContext {
  readonly market: {
    readonly timestamp: number;
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume: number;
    readonly markPrice: number;
    readonly fundingRate: number;
    readonly openInterest: number | null;
  };
  readonly account: {
    readonly equity: number;
  };
  readonly position: {
    readonly side: "flat" | "long" | "short";
    readonly quantity: number;
    readonly entryPrice: number | null;
    readonly unrealizedPnl: number;
  };
  readonly indicators: {
    sma(field: "open" | "high" | "low" | "close" | "volume", period: number, offset?: number): number | null;
    ema(field: "open" | "high" | "low" | "close" | "volume", period: number, offset?: number): number | null;
    highest(field: "open" | "high" | "low" | "close" | "volume", period: number, offset?: number): number | null;
    lowest(field: "open" | "high" | "low" | "close" | "volume", period: number, offset?: number): number | null;
    percentChange(field: "close" | "openInterest", periods: number): number | null;
    standardDeviation(field: "open" | "high" | "low" | "close" | "volume", period: number, offset?: number): number | null;
    rsi(field: "close", period: number, offset?: number): number | null;
    atr(period: number, offset?: number): number | null;
    macd(
      field: "close",
      fastPeriod?: number,
      slowPeriod?: number,
      signalPeriod?: number,
      offset?: number,
    ): { macd: number; signal: number; histogram: number } | null;
    bollingerBands(
      field: "open" | "high" | "low" | "close" | "volume",
      period: number,
      standardDeviations?: number,
      offset?: number,
    ): { middle: number; upper: number; lower: number } | null;
  };
  readonly history: {
    values(
      field: "open" | "high" | "low" | "close" | "volume" | "markPrice" | "fundingRate" | "openInterest",
      period: number,
      offset?: number,
    ): readonly number[] | null;
    bars(period: number, offset?: number): readonly {
      timestamp: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      markPrice: number;
      fundingRate: number;
      openInterest: number | null;
    }[] | null;
  };
  timeframe(interval: "1m" | "15m" | "1h" | "4h"): Pick<StrategyContext, "market" | "indicators" | "history"> | null;
  readonly state: {
    get<T extends JsonValue>(key: string, fallback: T): T;
    get(key: string): JsonValue | undefined;
    set(key: string, value: JsonValue): void;
  };
  crossedAbove(currentA: number | null, previousA: number | null, currentB: number | null, previousB: number | null): boolean;
  crossedBelow(currentA: number | null, previousA: number | null, currentB: number | null, previousB: number | null): boolean;
}

export interface StrategyDefinition {
  id: string;
  name: string;
  version: number;
  onBar(context: StrategyContext): StrategyDecision;
}

/**
 * This declaration is the contract shown to the code-generating model and editor.
 * The sandbox injects the runtime implementation.
 */
export declare function defineStrategy(definition: StrategyDefinition): StrategyDefinition;
