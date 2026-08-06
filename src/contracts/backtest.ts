import type { Timeframe } from "../core/timeframes.js";
import type { BacktestConfig, ClosedTrade, EquityPoint, StrategyState } from "../core/types.js";
import type { BacktestMetrics } from "../runtime/backtest-metrics.js";

/**
 * Wire-safe bar accepted by the backtest service. This is deliberately a subset
 * of `MarketBar`: the Web data pipeline currently transports OHLCV klines, and
 * the derivative fields are optional so a caller that lacks funding/OI data can
 * still run deterministic backtests (absent fields degrade to close/false/zero
 * in the engine).
 */
export interface ServiceBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  markPrice?: number;
  fundingRate?: number;
  openInterest?: number;
  quoteVolume?: number;
  takerBuyBaseVolume?: number;
  takerBuyQuoteVolume?: number;
}

export type ServiceTimeframe = Timeframe;

/** Multi-timeframe context mirrors `BacktestTimeframeContext` on the wire. */
export interface ServiceTimeframeContext {
  primaryTimeframe: ServiceTimeframe;
  bars: Partial<Record<ServiceTimeframe, ServiceBar[]>>;
}

export interface ServiceBacktestConfig {
  initialCapital: number;
  takerFeeRate: number;
  slippageBps: number;
  maxLeverage: number;
}

export const BACKTEST_CONTRACT_VERSION = "backtest-1.0" as const;

export interface BacktestServiceRequest {
  schemaVersion: typeof BACKTEST_CONTRACT_VERSION;
  /** The exact `defineStrategy({...})` TypeScript source; the only execution truth. */
  source: string;
  /** Optional digest so the service can bind results to an input fingerprint. */
  sourceHash?: string;
  bars: ServiceBar[];
  config: ServiceBacktestConfig;
  timeframeContext?: ServiceTimeframeContext;
}

export interface BacktestServiceResponse {
  schemaVersion: typeof BACKTEST_CONTRACT_VERSION;
  sourceHash: string;
  strategy: { id: string; name: string; version: number; programHash: string };
  config: BacktestConfig;
  initialCapital: number;
  finalEquity: number;
  returnPercent: number;
  metrics: BacktestMetrics;
  trades: ClosedTrade[];
  equityCurve: EquityPoint[];
  finalState: StrategyState;
  /** Wall-clock execution of the deterministic engine, in milliseconds. */
  executionMs: number;
}
