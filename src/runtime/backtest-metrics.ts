import type { BacktestResult } from "../core/types.js";

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1_000;

export interface BacktestMetrics {
  netReturn: number;
  cagr: number | null;
  maximumDrawdown: number;
  maximumDrawdownDurationMs: number;
  sharpe: number | null;
  sortino: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  winRate: number | null;
  exposure: number;
  tradeCount: number;
  winningTrades: number;
  losingTrades: number;
  longTrades: number;
  shortTrades: number;
  grossPnl: number;
  netPnl: number;
  fees: number;
  fundingPnl: number;
  slippageCost: number;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function calculateBacktestMetrics(result: BacktestResult): BacktestMetrics {
  const firstPoint = result.equityCurve[0];
  const lastPoint = result.equityCurve.at(-1);
  const durationMs = firstPoint && lastPoint ? Math.max(0, lastPoint.timestamp - firstPoint.timestamp) : 0;
  const years = durationMs / YEAR_MS;
  const cagr = years > 0 && result.initialCapital > 0 && result.finalEquity > 0
    ? (result.finalEquity / result.initialCapital) ** (1 / years) - 1
    : null;

  let peak = result.initialCapital;
  let peakTimestamp = firstPoint?.timestamp ?? 0;
  let maximumDrawdown = 0;
  let maximumDrawdownDurationMs = 0;
  for (const point of result.equityCurve) {
    if (point.equity >= peak) {
      peak = point.equity;
      peakTimestamp = point.timestamp;
      continue;
    }
    const drawdown = peak > 0 ? point.equity / peak - 1 : 0;
    if (drawdown < maximumDrawdown) maximumDrawdown = drawdown;
    maximumDrawdownDurationMs = Math.max(maximumDrawdownDurationMs, point.timestamp - peakTimestamp);
  }

  const returns: number[] = [];
  for (let index = 1; index < result.equityCurve.length; index += 1) {
    const previous = result.equityCurve[index - 1]?.equity;
    const current = result.equityCurve[index]?.equity;
    if (previous && current !== undefined && previous > 0) returns.push(current / previous - 1);
  }
  const intervalMs = result.equityCurve.length > 1
    ? Math.max(1, (lastPoint?.timestamp ?? 0) - (firstPoint?.timestamp ?? 0)) / (result.equityCurve.length - 1)
    : YEAR_MS;
  const annualization = Math.sqrt(YEAR_MS / intervalMs);
  const meanReturn = returns.length > 0 ? average(returns) : 0;
  const volatility = standardDeviation(returns, meanReturn);
  const downside = returns.filter((value) => value < 0);
  const downsideDeviation = downside.length > 0
    ? Math.sqrt(downside.reduce((sum, value) => sum + value ** 2, 0) / downside.length)
    : 0;

  const netPnls = result.trades.map((trade) => trade.netPnl);
  const winningTrades = netPnls.filter((value) => value > 0).length;
  const losingTrades = netPnls.filter((value) => value < 0).length;
  const grossProfit = netPnls.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(netPnls.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const occupiedMs = result.trades.reduce((sum, trade) => sum + Math.max(0, trade.exitTimestamp - trade.entryTimestamp), 0);

  return {
    netReturn: result.returnPercent,
    cagr,
    maximumDrawdown,
    maximumDrawdownDurationMs,
    sharpe: volatility > 0 ? (meanReturn / volatility) * annualization : null,
    sortino: downsideDeviation > 0 ? (meanReturn / downsideDeviation) * annualization : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    expectancy: netPnls.length > 0 ? average(netPnls) : null,
    winRate: netPnls.length > 0 ? winningTrades / netPnls.length : null,
    exposure: durationMs > 0 ? Math.min(1, occupiedMs / durationMs) : 0,
    tradeCount: result.trades.length,
    winningTrades,
    losingTrades,
    longTrades: result.trades.filter((trade) => trade.side === "long").length,
    shortTrades: result.trades.filter((trade) => trade.side === "short").length,
    grossPnl: result.trades.reduce((sum, trade) => sum + trade.grossPnl, 0),
    netPnl: result.finalEquity - result.initialCapital,
    fees: result.trades.reduce((sum, trade) => sum + trade.fees, 0),
    fundingPnl: result.trades.reduce((sum, trade) => sum + trade.fundingPnl, 0),
    slippageCost: result.trades.reduce((sum, trade) => sum + trade.slippageCost, 0),
  };
}
