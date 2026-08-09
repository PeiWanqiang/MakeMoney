import type { FastifyInstance } from "fastify";

import { compileStrategySource, StrategyCompilationError } from "../../../src/compiler/compile-strategy-source.js";
import {
  BACKTEST_CONTRACT_VERSION,
  type BacktestServiceRequest,
  type BacktestServiceResponse,
  type ServiceTimeframeContext,
} from "../../../src/contracts/index.js";
import { isTimeframe } from "../../../src/core/timeframes.js";
import { runCompiledBacktest, type BacktestTimeframeContext } from "../../../src/runtime/backtest.js";
import { calculateBacktestMetrics } from "../../../src/runtime/backtest-metrics.js";
import { CodedServiceError } from "../lib/errors.js";
import { serviceBarsToMarketBars, validateServiceBars, validateServiceConfig } from "../lib/bars.js";

function validateRequest(body: BacktestServiceRequest): void {
  if (!body || typeof body !== "object" || typeof body.source !== "string") {
    throw new CodedServiceError("BAD_REQUEST", "Request must include a strategy source and a bars array.", 400);
  }
  if (body.schemaVersion !== BACKTEST_CONTRACT_VERSION) {
    throw new CodedServiceError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `schemaVersion must be '${BACKTEST_CONTRACT_VERSION}'.`,
      400,
    );
  }
  validateServiceBars(body.bars);
  validateServiceConfig(body.config);
}

function mapTimeframeContext(context: ServiceTimeframeContext | undefined): BacktestTimeframeContext | undefined {
  if (!context) return undefined;
  if (!isTimeframe(context.primaryTimeframe) || !context.bars || typeof context.bars !== "object" || Array.isArray(context.bars)) {
    throw new CodedServiceError("BAD_REQUEST", "timeframeContext must include a valid primaryTimeframe and bars map.", 400);
  }
  const bars: BacktestTimeframeContext["bars"] = {};
  for (const [interval, rows] of Object.entries(context.bars)) {
    if (!isTimeframe(interval)) {
      throw new CodedServiceError("BAD_REQUEST", `timeframeContext contains unsupported interval '${interval}'.`, 400);
    }
    if (rows) {
      validateServiceBars(rows, `timeframeContext.bars.${interval}`, 1);
      bars[interval as keyof typeof bars] = serviceBarsToMarketBars(rows);
    }
  }
  return { primaryTimeframe: context.primaryTimeframe, bars };
}

export function registerBacktestRoutes(app: FastifyInstance): void {
  app.post<{ Body: BacktestServiceRequest }>("/v1/backtest", async (request, reply) => {
    const body = request.body;
    validateRequest(body);
    try {
      const started = Date.now();
      const program = compileStrategySource(body.source);
      if (body.sourceHash !== undefined && body.sourceHash !== program.sourceHash) {
        throw new CodedServiceError(
          "SOURCE_HASH_MISMATCH",
          "sourceHash does not match the compiled strategy program.",
          409,
        );
      }
      const bars = serviceBarsToMarketBars(body.bars);
      const result = await runCompiledBacktest(
        program,
        bars,
        body.config,
        mapTimeframeContext(body.timeframeContext),
      );
      const executionMs = Date.now() - started;
      const response: BacktestServiceResponse = {
        schemaVersion: BACKTEST_CONTRACT_VERSION,
        sourceHash: program.sourceHash,
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
