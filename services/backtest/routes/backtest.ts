import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { StrategyCompilationError } from "../../../src/compiler/compile-strategy-source.js";
import {
  BACKTEST_CONTRACT_VERSION,
  type BacktestServiceRequest,
  type BacktestServiceResponse,
  type ServiceBar,
  type ServiceTimeframeContext,
} from "../../../src/contracts/index.js";
import type { MarketBar } from "../../../src/core/types.js";
import { runBacktest, type BacktestTimeframeContext } from "../../../src/runtime/backtest.js";
import { calculateBacktestMetrics } from "../../../src/runtime/backtest-metrics.js";
import { CodedServiceError } from "../lib/errors.js";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateRequest(body: BacktestServiceRequest): void {
  if (!body || typeof body.source !== "string" || !Array.isArray(body.bars)) {
    throw new CodedServiceError("BAD_REQUEST", "Request must include a strategy source and a bars array.", 400);
  }
  if (body.bars.length < 2) {
    throw new CodedServiceError("BAD_REQUEST", "Backtest requires at least two market bars.", 400);
  }
  const config = body.config ?? {};
  for (const field of ["initialCapital", "takerFeeRate", "slippageBps", "maxLeverage"] as const) {
    if (config[field] !== undefined && !isFiniteNumber(config[field])) {
      throw new CodedServiceError("BAD_REQUEST", `config.${field} must be a finite number.`, 400);
    }
  }
  for (const [index, bar] of body.bars.entries()) {
    if (!bar || !isFiniteNumber(bar.timestamp) || !isFiniteNumber(bar.open) || !isFiniteNumber(bar.high)
      || !isFiniteNumber(bar.low) || !isFiniteNumber(bar.close) || !isFiniteNumber(bar.volume)) {
      throw new CodedServiceError("BAD_REQUEST", `bars[${index}] is missing a required OHLCV field.`, 400);
    }
  }
}

function serviceBarsToMarketBars(bars: ServiceBar[]): MarketBar[] {
  return bars.map((bar) => ({
    timestamp: bar.timestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    ...(bar.markPrice !== undefined ? { markPrice: bar.markPrice } : {}),
    ...(bar.fundingRate !== undefined ? { fundingRate: bar.fundingRate } : {}),
    ...(bar.openInterest !== undefined ? { openInterest: bar.openInterest } : {}),
    ...(bar.quoteVolume !== undefined ? { quoteVolume: bar.quoteVolume } : {}),
    ...(bar.takerBuyBaseVolume !== undefined ? { takerBuyBaseVolume: bar.takerBuyBaseVolume } : {}),
    ...(bar.takerBuyQuoteVolume !== undefined ? { takerBuyQuoteVolume: bar.takerBuyQuoteVolume } : {}),
  }));
}

function mapTimeframeContext(context: ServiceTimeframeContext | undefined): BacktestTimeframeContext | undefined {
  if (!context) return undefined;
  const bars: BacktestTimeframeContext["bars"] = {};
  for (const [interval, rows] of Object.entries(context.bars)) {
    if (rows) bars[interval as keyof typeof bars] = serviceBarsToMarketBars(rows);
  }
  return { primaryTimeframe: context.primaryTimeframe, bars };
}

export function registerBacktestRoutes(app: FastifyInstance): void {
  app.post<{ Body: BacktestServiceRequest }>("/v1/backtest", async (request, reply) => {
    const body = request.body;
    validateRequest(body);
    const sourceHash = body.sourceHash ?? createHash("sha256").update(body.source).digest("hex");
    try {
      const started = Date.now();
      const bars = serviceBarsToMarketBars(body.bars);
      const result = await runBacktest(
        body.source,
        bars,
        body.config,
        mapTimeframeContext(body.timeframeContext),
      );
      const executionMs = Date.now() - started;
      const response: BacktestServiceResponse = {
        schemaVersion: BACKTEST_CONTRACT_VERSION,
        sourceHash,
        strategy: result.strategy,
        config: result.config,
        initialCapital: result.initialCapital,
        finalEquity: result.finalEquity,
        returnPercent: result.returnPercent,
        metrics: calculateBacktestMetrics(result),
        trades: result.trades,
        equityCurve: result.equityCurve,
        finalState: result.finalState,
        executionMs,
      };
      reply.header("cache-control", "no-store");
      return response;
    } catch (error) {
      if (error instanceof StrategyCompilationError) {
        throw new CodedServiceError("COMPILE_FAILED", error.message, 422, error.diagnostics);
      }
      throw error;
    }
  });
}
