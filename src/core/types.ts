export interface MarketBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  markPrice?: number;
  fundingRate?: number;
  openInterest?: number;
  /** Quote-currency turnover (Binance kline column 7). Absent when the source does not provide it. */
  quoteVolume?: number;
  /** Taker-buy base volume (Binance kline column 9). Absent when the source does not provide it. */
  takerBuyBaseVolume?: number;
  /** Taker-buy quote volume (Binance kline column 10). Absent when the source does not provide it. */
  takerBuyQuoteVolume?: number;
}

export type PositionSide = "flat" | "long" | "short";

export interface RuntimePosition {
  side: PositionSide;
  quantity: number;
  entryPrice: number | null;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  unrealizedPnl: number;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type StrategyState = Record<string, JsonValue>;

export interface HoldDecision {
  type: "hold";
  reason?: string;
}

export interface OpenDecision {
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

export interface CloseDecision {
  type: "close";
  reason?: string;
}

export type StrategyDecision = HoldDecision | OpenDecision | CloseDecision;

export interface StrategyProgramResult {
  strategy: {
    id: string;
    name: string;
    version: number;
    programHash: string;
  };
  decision: StrategyDecision;
  state: StrategyState;
}

export interface BacktestConfig {
  initialCapital: number;
  takerFeeRate: number;
  slippageBps: number;
  maxLeverage: number;
}

export interface ClosedTrade {
  side: "long" | "short";
  entryTimestamp: number;
  exitTimestamp: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  grossPnl: number;
  fundingPnl: number;
  fees: number;
  slippageCost: number;
  netPnl: number;
  exitReason: string;
}

export interface EquityPoint {
  timestamp: number;
  equity: number;
}

export interface BacktestResult {
  strategy: StrategyProgramResult["strategy"];
  config: BacktestConfig;
  initialCapital: number;
  finalEquity: number;
  returnPercent: number;
  trades: ClosedTrade[];
  equityCurve: EquityPoint[];
  finalState: StrategyState;
}
