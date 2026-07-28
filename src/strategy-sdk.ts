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
  };
  readonly state: {
    get(key: string, fallback?: JsonValue): JsonValue | undefined;
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

