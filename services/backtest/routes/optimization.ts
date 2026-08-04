import type { FastifyInstance } from "fastify";

import {
  BLIND_CONTRACT_VERSION,
  MATERIALIZE_CONTRACT_VERSION,
  OPTIMIZATION_CONTRACT_VERSION,
  type BlindServiceRequest,
  type BlindServiceResponse,
  type MaterializeRequest,
  type MaterializeResponse,
  type OptimizationServiceRequest,
  type OptimizationServiceResponse,
  type ServiceBacktestConfig,
} from "../../../src/contracts/index.js";
import type { StrategyContract } from "../../../src/semantics/contract.js";
import { runBlindTest } from "../../../src/optimization/blind-test.js";
import { runParameterOptimization } from "../../../src/optimization/optimization.js";
import { applyParametersToSource } from "../../../src/optimization/program-apply.js";
import {
  extractParameterSchema,
  type ParameterDefinition,
  type ParameterSelection,
} from "../../../src/optimization/parameter-discovery.js";
import { CodedServiceError } from "../lib/errors.js";
import { isFiniteNumber, serviceBarsToMarketBars } from "../lib/bars.js";

const MAX_OPTIMIZATION_PARAMETERS = 4;
const MAX_OPTIMIZATION_TRIALS = 16;

function isContract(value: unknown): value is StrategyContract {
  if (!value || typeof value !== "object") return false;
  const contract = value as Record<string, unknown>;
  return typeof contract.timeframe === "string" && Array.isArray(contract.rules);
}

function validateConfig(config: ServiceBacktestConfig | undefined, label: string): void {
  if (!config) return;
  for (const field of ["initialCapital", "takerFeeRate", "slippageBps", "maxLeverage"] as const) {
    if (config[field] !== undefined && !isFiniteNumber(config[field])) {
      throw new CodedServiceError("BAD_REQUEST", `${label}.${field} must be a finite number.`, 400);
    }
  }
}

function validateSelections(value: unknown, definitions: ParameterDefinition[]): ParameterSelection[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CodedServiceError("BAD_REQUEST", "请至少选择一个可调参数", 400);
  }
  if (value.length > MAX_OPTIMIZATION_PARAMETERS) {
    throw new CodedServiceError("BAD_REQUEST", `一次最多调整 ${MAX_OPTIMIZATION_PARAMETERS} 个参数`, 400);
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new CodedServiceError("BAD_REQUEST", "参数实验范围无效", 400);
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const definition = definitions.find((candidate) => candidate.id === id);
    if (!definition || seen.has(id)) {
      throw new CodedServiceError("BAD_REQUEST", `未知或重复的策略参数 ${id || "（空）"}`, 400);
    }
    seen.add(id);
    let minimum = Number(record.min);
    let maximum = Number(record.max);
    const steps = Math.round(Number(record.steps));
    if (definition.kind === "integer") {
      minimum = Math.round(minimum);
      maximum = Math.round(maximum);
    }
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum >= maximum) {
      throw new CodedServiceError("BAD_REQUEST", `${definition.label} 的上下限无效`, 400);
    }
    if (minimum < definition.hardMin || maximum > definition.hardMax) {
      throw new CodedServiceError("BAD_REQUEST", `${definition.label} 超出安全边界 ${definition.hardMin}～${definition.hardMax}`, 400);
    }
    if (!Number.isInteger(steps) || steps < 2 || steps > 7) {
      throw new CodedServiceError("BAD_REQUEST", `${definition.label} 的取值点数必须为 2～7`, 400);
    }
    return { id, min: minimum, max: maximum, steps };
  });
}

function validateCandidateValues(values: unknown, definitions: ParameterDefinition[]): Record<string, number> {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new CodedServiceError("BAD_REQUEST", "候选参数值无效", 400);
  }
  const result: Record<string, number> = {};
  for (const [id, raw] of Object.entries(values as Record<string, unknown>)) {
    const definition = definitions.find((item) => item.id === id);
    if (!definition) throw new CodedServiceError("BAD_REQUEST", `未知策略参数 ${id}`, 400);
    const value = definition.kind === "integer" ? Math.round(Number(raw)) : Number(raw);
    if (!Number.isFinite(value) || value < definition.hardMin || value > definition.hardMax) {
      throw new CodedServiceError("BAD_REQUEST", `参数 ${definition.label} 超出安全范围`, 400);
    }
    result[id] = value;
  }
  return result;
}

export function registerOptimizationRoutes(app: FastifyInstance): void {
  app.post<{ Body: OptimizationServiceRequest }>("/v1/optimization/run", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body.source !== "string" || !isContract(body.contract) || !Array.isArray(body.bars)) {
      throw new CodedServiceError("BAD_REQUEST", "Request must include a source, a contract and bars.", 400);
    }
    validateConfig(body.config, "config");
    const definitions = extractParameterSchema(body.contract);
    if (definitions.length === 0) {
      throw new CodedServiceError("NO_TUNABLE_PARAMETERS", "这份策略没有可安全调整的数字参数", 409);
    }
    const selections = validateSelections(body.selections, definitions);
    const objective = body.objective === "return" || body.objective === "drawdown" ? body.objective : "balanced";
    const maximumTrials = Math.round(Number(body.maximumTrials) || 12);
    if (!Number.isFinite(maximumTrials) || maximumTrials < 6 || maximumTrials > MAX_OPTIMIZATION_TRIALS) {
      throw new CodedServiceError("BAD_REQUEST", `maxTrials 必须为 6～${MAX_OPTIMIZATION_TRIALS}`, 400);
    }
    const bars = serviceBarsToMarketBars(body.bars);
    if (bars.length < 60) {
      throw new CodedServiceError("BAD_REQUEST", "优化至少需要 60 根完整K线，以便隔离训练、滚动验证和盲测区间", 400);
    }
    const started = Date.now();
    const result = await runParameterOptimization({
      source: body.source,
      contract: body.contract,
      selections,
      objective,
      maximumTrials,
      bars,
      config: body.config ?? {},
    });
    const response: OptimizationServiceResponse = {
      schemaVersion: OPTIMIZATION_CONTRACT_VERSION,
      result,
      executionMs: Date.now() - started,
    };
    reply.header("cache-control", "no-store");
    return response;
  });

  app.post<{ Body: BlindServiceRequest }>("/v1/optimization/blind", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body.source !== "string" || !isContract(body.contract) || !Array.isArray(body.bars)) {
      throw new CodedServiceError("BAD_REQUEST", "Request must include a source, a contract and bars.", 400);
    }
    if (!isFiniteNumber(body.blindStartTime)) {
      throw new CodedServiceError("BAD_REQUEST", "blindStartTime must be a finite timestamp.", 400);
    }
    validateConfig(body.config, "config");
    const definitions = extractParameterSchema(body.contract);
    const candidateParameters = validateCandidateValues(body.candidateParameters, definitions);
    const bars = serviceBarsToMarketBars(body.bars);
    const started = Date.now();
    const outcome = await runBlindTest({
      source: body.source,
      contract: body.contract,
      definitions,
      candidateParameters,
      bars,
      config: body.config ?? {},
      blindStartTime: body.blindStartTime,
    });
    const response: BlindServiceResponse = {
      schemaVersion: BLIND_CONTRACT_VERSION,
      outcome,
      executionMs: Date.now() - started,
    };
    reply.header("cache-control", "no-store");
    return response;
  });

  app.post<{ Body: MaterializeRequest }>("/v1/optimization/materialize", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body.source !== "string" || !isContract(body.contract)) {
      throw new CodedServiceError("BAD_REQUEST", "Request must include a source and a contract.", 400);
    }
    const definitions = extractParameterSchema(body.contract);
    const parameters = validateCandidateValues(body.parameters, definitions);
    const source = applyParametersToSource(body.source, body.contract, definitions, parameters);
    const response: MaterializeResponse = {
      schemaVersion: MATERIALIZE_CONTRACT_VERSION,
      source,
    };
    reply.header("cache-control", "no-store");
    return response;
  });
}
