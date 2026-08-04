import type {
  BacktestConfig,
  BacktestResult,
  ClosedTrade,
  MarketBar,
  OpenDecision,
  RuntimePosition,
  StrategyDecision,
  StrategyProgramResult,
  StrategyState,
} from "../core/types.js";
import { compileStrategySource } from "../compiler/compile-strategy-source.js";
import { StrategySandboxSession } from "./sandbox.js";

const DEFAULT_CONFIG: BacktestConfig = {
  initialCapital: 10_000,
  takerFeeRate: 0.00045,
  slippageBps: 2,
  maxLeverage: 3,
};

export type StrategyTimeframe = "1m" | "15m" | "1h" | "4h";

const TIMEFRAME_MS: Record<StrategyTimeframe, number> = {
  "1m": 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
};

export interface BacktestTimeframeContext {
  primaryTimeframe: StrategyTimeframe;
  bars: Partial<Record<StrategyTimeframe, MarketBar[]>>;
}

interface OpenPosition {
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  entryTimestamp: number;
  entryFee: number;
  entrySlippageCost: number;
  fundingPnl: number;
  stopPrice: number;
  takeProfitPrice: number | null;
}

function emptyPosition(): RuntimePosition {
  return {
    side: "flat",
    quantity: 0,
    entryPrice: null,
    stopPrice: null,
    takeProfitPrice: null,
    unrealizedPnl: 0,
  };
}

function runtimePosition(position: OpenPosition | null, markPrice: number): RuntimePosition {
  if (!position) {
    return emptyPosition();
  }
  const direction = position.side === "long" ? 1 : -1;
  return {
    side: position.side,
    quantity: position.quantity,
    entryPrice: position.entryPrice,
    stopPrice: position.stopPrice,
    takeProfitPrice: position.takeProfitPrice,
    unrealizedPnl: direction * (markPrice - position.entryPrice) * position.quantity,
  };
}

function withSlippage(price: number, side: "buy" | "sell", bps: number): number {
  const rate = bps / 10_000;
  return side === "buy" ? price * (1 + rate) : price * (1 - rate);
}

function positionQuantity(decision: OpenDecision, fillPrice: number, equity: number, maxLeverage: number): number {
  const maxNotional = Math.max(0, equity * maxLeverage);
  let requestedNotional: number;
  if (decision.size.kind === "fixedNotional") {
    requestedNotional = decision.size.value;
  } else if (decision.size.kind === "equityPercent") {
    requestedNotional = equity * decision.size.value;
  } else {
    const riskCapital = equity * decision.size.value;
    requestedNotional = riskCapital / decision.stopLossPercent;
  }
  return Math.min(requestedNotional, maxNotional) / fillPrice;
}

export async function runBacktest(
  source: string,
  bars: MarketBar[],
  overrides: Partial<BacktestConfig> = {},
  timeframeContext?: BacktestTimeframeContext,
): Promise<BacktestResult> {
  if (bars.length < 2) {
    throw new Error("Backtest requires at least two market bars.");
  }

  const config: BacktestConfig = { ...DEFAULT_CONFIG, ...overrides };
  const program = compileStrategySource(source);
  let cash = config.initialCapital;
  let position: OpenPosition | null = null;
  let state: StrategyState = {};
  let pendingDecision: StrategyDecision | null = null;
  let strategyMetadata: StrategyProgramResult["strategy"] | null = null;
  const trades: ClosedTrade[] = [];
  const equityCurve: BacktestResult["equityCurve"] = [];
  const sandbox = await StrategySandboxSession.create(program);
  const timeframePointers = new Map<StrategyTimeframe, number>();
  const sortedTimeframes = Object.fromEntries(
    Object.entries(timeframeContext?.bars ?? {}).map(([interval, rows]) => [
      interval,
      [...(rows ?? [])].sort((left, right) => left.timestamp - right.timestamp),
    ]),
  ) as Partial<Record<StrategyTimeframe, MarketBar[]>>;

  const closePosition = (bar: MarketBar, rawPrice: number, reason: string): void => {
    if (!position) return;
    const closingSide = position.side === "long" ? "sell" : "buy";
    const exitPrice = withSlippage(rawPrice, closingSide, config.slippageBps);
    const exitSlippageCost = Math.abs(exitPrice - rawPrice) * position.quantity;
    const direction = position.side === "long" ? 1 : -1;
    const grossPnl = direction * (exitPrice - position.entryPrice) * position.quantity;
    const exitFee = exitPrice * position.quantity * config.takerFeeRate;
    cash += grossPnl - exitFee;
    const fees = position.entryFee + exitFee;
    trades.push({
      side: position.side,
      entryTimestamp: position.entryTimestamp,
      exitTimestamp: bar.timestamp,
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.quantity,
      grossPnl,
      fundingPnl: position.fundingPnl,
      fees,
      slippageCost: position.entrySlippageCost + exitSlippageCost,
      netPnl: grossPnl + position.fundingPnl - fees,
      exitReason: reason,
    });
    position = null;
  };

  try {
    const evaluationStartTime = config.evaluationStartTime ?? bars[0]!.timestamp;
    let windowBarCount = 0;
    for (let index = 0; index < bars.length; index += 1) {
      const bar = bars[index];
      if (!bar) continue;
      const inWindow = bar.timestamp >= evaluationStartTime;

      if (inWindow) {
        if (pendingDecision?.type === "open" && !position) {
          const fillSide = pendingDecision.side === "long" ? "buy" : "sell";
          const entryPrice = withSlippage(bar.open, fillSide, config.slippageBps);
          const quantity = positionQuantity(pendingDecision, entryPrice, cash, config.maxLeverage);
          const entryFee = entryPrice * quantity * config.takerFeeRate;
          cash -= entryFee;
          const direction = pendingDecision.side === "long" ? 1 : -1;
          const stopDistance = entryPrice * pendingDecision.stopLossPercent;
          position = {
            side: pendingDecision.side,
            quantity,
            entryPrice,
            entryTimestamp: bar.timestamp,
            entryFee,
            entrySlippageCost: Math.abs(entryPrice - bar.open) * quantity,
            fundingPnl: 0,
            stopPrice: entryPrice - direction * stopDistance,
            takeProfitPrice:
              pendingDecision.takeProfitRiskReward === undefined
                ? null
                : entryPrice + direction * stopDistance * pendingDecision.takeProfitRiskReward,
          };
        } else if (pendingDecision?.type === "close" && position) {
          closePosition(bar, bar.open, pendingDecision.reason ?? "strategy");
        }
      }
      pendingDecision = null;

      if (inWindow && position) {
        const notional = position.quantity * (bar.markPrice ?? bar.close);
        const direction = position.side === "long" ? 1 : -1;
        const fundingPnl = -direction * notional * (bar.fundingRate ?? 0);
        cash += fundingPnl;
        position.fundingPnl += fundingPnl;

        const stopHit = position.side === "long" ? bar.low <= position.stopPrice : bar.high >= position.stopPrice;
        const takeProfitHit =
          position.takeProfitPrice !== null &&
          (position.side === "long" ? bar.high >= position.takeProfitPrice : bar.low <= position.takeProfitPrice);

        // Conservative and deterministic: if both happen in one bar, assume the stop was hit first.
        if (stopHit) {
          closePosition(bar, position.stopPrice, "stopLoss");
        } else if (takeProfitHit && position?.takeProfitPrice !== null) {
          closePosition(bar, position.takeProfitPrice, "takeProfit");
        }
      }

      const markPrice = bar.markPrice ?? bar.close;
      const currentPosition = runtimePosition(position, markPrice);
      const equity = cash + currentPosition.unrealizedPnl;
      if (inWindow) {
        equityCurve.push({ timestamp: bar.timestamp, equity });
        windowBarCount += 1;
      }

      const newlyClosedTimeframes: Partial<Record<StrategyTimeframe, MarketBar[]>> = {};
      if (timeframeContext) {
        const decisionTime = bar.timestamp + TIMEFRAME_MS[timeframeContext.primaryTimeframe];
        for (const interval of Object.keys(sortedTimeframes) as StrategyTimeframe[]) {
          const rows = sortedTimeframes[interval] ?? [];
          let pointer = timeframePointers.get(interval) ?? 0;
          const start = pointer;
          while (pointer < rows.length) {
            const candidate = rows[pointer];
            if (!candidate || candidate.timestamp + TIMEFRAME_MS[interval] > decisionTime) break;
            pointer += 1;
          }
          if (pointer > start) newlyClosedTimeframes[interval] = rows.slice(start, pointer);
          timeframePointers.set(interval, pointer);
        }
      }
      const invocation = await sandbox.runBar(bar, currentPosition, equity, state, newlyClosedTimeframes);
      strategyMetadata ??= invocation.strategy;
      state = invocation.state;
      pendingDecision = inWindow ? invocation.decision : null;
    }
    if (windowBarCount < 2) {
      throw new Error("Performance window requires at least two market bars.");
    }
  } finally {
    sandbox.dispose();
  }

  const lastBar = bars.at(-1);
  if (position && lastBar) {
    closePosition(lastBar, lastBar.close, "endOfData");
    const lastPoint = equityCurve.at(-1);
    if (lastPoint) lastPoint.equity = cash;
  }

  if (!strategyMetadata) {
    throw new Error("Strategy did not produce metadata.");
  }

  return {
    strategy: strategyMetadata,
    config,
    initialCapital: config.initialCapital,
    finalEquity: cash,
    returnPercent: cash / config.initialCapital - 1,
    trades,
    equityCurve,
    finalState: state,
  };
}
