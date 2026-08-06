/**
 * The compile-time contract available to generated strategy programs.
 * Keep this declaration aligned with src/strategy-sdk.ts and the sandbox runtime.
 */
export const STRATEGY_SDK_DECLARATION = `
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type MarketField =
  | "open"
  | "high"
  | "low"
  | "close"
  | "volume"
  | "quoteVolume"
  | "takerBuyBaseVolume"
  | "takerBuyQuoteVolume";

type StrategyDecision =
  | { type: "hold"; reason?: string }
  | {
      type: "open";
      side: "long" | "short";
      size:
        | { kind: "riskPercent"; value: number }
        | { kind: "equityPercent"; value: number }
        | { kind: "fixedNotional"; value: number };
      stopLossPercent: number;
      takeProfitRiskReward?: number;
      reason?: string;
    }
  | { type: "close"; fraction?: number; reason?: string };

interface StrategyContext {
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
    readonly quoteVolume: number | null;
    readonly takerBuyBaseVolume: number | null;
    readonly takerBuyQuoteVolume: number | null;
  };
  readonly account: { readonly equity: number };
  readonly position: {
    readonly side: "flat" | "long" | "short";
    readonly quantity: number;
    readonly entryPrice: number | null;
    readonly unrealizedPnl: number;
  };
  readonly indicators: {
    sma(field: MarketField, period: number, offset?: number): number | null;
    ema(field: MarketField, period: number, offset?: number): number | null;
    highest(field: MarketField, period: number, offset?: number): number | null;
    lowest(field: MarketField, period: number, offset?: number): number | null;
    percentChange(field: "close" | "openInterest" | MarketField, periods: number): number | null;
    standardDeviation(field: MarketField, period: number, offset?: number): number | null;
    rsi(field: "close", period: number, offset?: number): number | null;
    atr(period: number, offset?: number): number | null;
    macd(field: "close", fastPeriod?: number, slowPeriod?: number, signalPeriod?: number, offset?: number): { macd: number; signal: number; histogram: number } | null;
    bollingerBands(field: MarketField, period: number, standardDeviations?: number, offset?: number): { middle: number; upper: number; lower: number } | null;
  };
  readonly history: {
    values(field: MarketField | "markPrice" | "fundingRate" | "openInterest", period: number, offset?: number): readonly number[] | null;
    bars(period: number, offset?: number): readonly {
      timestamp: number; open: number; high: number; low: number; close: number; volume: number;
      markPrice: number; fundingRate: number; openInterest: number | null;
      quoteVolume: number | null; takerBuyBaseVolume: number | null; takerBuyQuoteVolume: number | null;
    }[] | null;
  };
  timeframe(interval: "1m" | "15m" | "1h" | "4h" | "1d" | "1w"): Pick<StrategyContext, "market" | "indicators" | "history"> | null;
  readonly state: {
    get<T extends JsonValue>(key: string, fallback: T): T;
    get(key: string): JsonValue | undefined;
    set(key: string, value: JsonValue): void;
  };
  crossedAbove(currentA: number | null, previousA: number | null, currentB: number | null, previousB: number | null): boolean;
  crossedBelow(currentA: number | null, previousA: number | null, currentB: number | null, previousB: number | null): boolean;
}

interface StrategyDefinition {
  id: string;
  name: string;
  version: number;
  onBar(context: StrategyContext): StrategyDecision;
}

declare function defineStrategy(definition: StrategyDefinition): StrategyDefinition;
`.trim();
