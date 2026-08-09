import type { FastifyInstance } from "fastify";

import { compileStrategySource, StrategyCompilationError } from "../../../src/compiler/compile-strategy-source.js";
import {
  DEFAULT_AVAILABLE_CAPABILITIES,
  VERIFY_CONTRACT_VERSION,
  type VerifyCompileResult,
  type VerifyServiceRequest,
  type VerifyServiceResponse,
} from "../../../src/contracts/index.js";
import { usedCapabilities, type StrategyCapability } from "../../../src/semantics/capabilities.js";
import { parseStrategyContract, StrategyContractValidationError } from "../../../src/semantics/contract.js";
import { verifyStrategySemantics } from "../../../src/semantics/verify-semantics.js";
import { CodedServiceError } from "../lib/errors.js";

function isCapability(value: unknown): value is StrategyCapability {
  return typeof value === "string" && [
    "ohlcv", "turnover", "markPrice", "fundingRate", "openInterest",
    "multiTimeframe", "state", "indicators", "arithmetic",
  ].includes(value);
}

function compileSource(source: string): VerifyCompileResult {
  try {
    compileStrategySource(source);
    return { ok: true, diagnostics: [] };
  } catch (error) {
    if (error instanceof StrategyCompilationError) return { ok: false, diagnostics: error.diagnostics };
    throw error;
  }
}

export function registerVerifyRoutes(app: FastifyInstance): void {
  app.post<{ Body: VerifyServiceRequest }>("/v1/strategy/verify", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body.source !== "string") {
      throw new CodedServiceError("BAD_REQUEST", "Request must include a strategy source and a contract.", 400);
    }
    if (body.schemaVersion !== VERIFY_CONTRACT_VERSION) {
      throw new CodedServiceError(
        "UNSUPPORTED_SCHEMA_VERSION",
        `schemaVersion must be '${VERIFY_CONTRACT_VERSION}'.`,
        400,
      );
    }
    let contract: ReturnType<typeof parseStrategyContract>;
    try {
      contract = parseStrategyContract(body.contract);
    } catch (error) {
      if (error instanceof StrategyContractValidationError) {
        throw new CodedServiceError("BAD_REQUEST", error.message, 400);
      }
      throw error;
    }
    const available = Array.isArray(body.availableCapabilities) && body.availableCapabilities.every(isCapability)
      ? body.availableCapabilities
      : DEFAULT_AVAILABLE_CAPABILITIES;
    const availableSet = new Set<StrategyCapability>(available);

    const compiled = compileSource(body.source);
    const report = compiled.ok ? await verifyStrategySemantics(body.source, contract) : null;
    const used = compiled.ok ? [...usedCapabilities(body.source)].sort() : [];
    const unsupported = used.filter((capability) => !availableSet.has(capability));

    const semantics = {
      ok: report?.ok ?? false,
      diagnostics: report ? report.diagnostics.map((item) => ({ code: item.code, message: item.message })) : [],
      scenarioCount: report?.scenarios.length ?? 0,
      scenarioPassed: report ? report.scenarios.filter((scenario) => scenario.passed).length : 0,
    };

    const diagnostics = [
      ...(compiled.ok ? [] : compiled.diagnostics.map((item) => ({ code: item.code, message: item.message }))),
      ...semantics.diagnostics,
      ...unsupported.map((capability) => ({
        code: "UNSUPPORTED_CAPABILITY",
        message: `Strategy requires capability '${capability}' which the caller does not provide.`,
      })),
    ];

    const response: VerifyServiceResponse = {
      schemaVersion: VERIFY_CONTRACT_VERSION,
      ok: compiled.ok && semantics.ok && unsupported.length === 0,
      compiled,
      semantics,
      capabilities: { used, unsupported },
      diagnostics,
    };
    reply.header("cache-control", "no-store");
    return response;
  });
}
