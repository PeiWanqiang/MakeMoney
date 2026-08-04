import type { StrategyContract } from "../semantics/contract.js";
import type { OptimizationCoreResult } from "../optimization/optimization.js";
import type { BlindTestOutcome } from "../optimization/blind-test.js";
import type { ParameterSelection } from "../optimization/parameter-discovery.js";
import type { ServiceBar, ServiceBacktestConfig } from "./backtest.js";

export const OPTIMIZATION_CONTRACT_VERSION = "optimization-1.0" as const;
export const BLIND_CONTRACT_VERSION = "blind-1.0" as const;

export type OptimizationObjective = "balanced" | "return" | "drawdown";

export interface OptimizationServiceRequest {
  schemaVersion: typeof OPTIMIZATION_CONTRACT_VERSION;
  source: string;
  contract: StrategyContract;
  selections: ParameterSelection[];
  objective: OptimizationObjective;
  maximumTrials: number;
  bars: ServiceBar[];
  config: ServiceBacktestConfig;
}

export interface OptimizationServiceResponse {
  schemaVersion: typeof OPTIMIZATION_CONTRACT_VERSION;
  result: OptimizationCoreResult;
  executionMs: number;
}

export interface BlindServiceRequest {
  schemaVersion: typeof BLIND_CONTRACT_VERSION;
  source: string;
  contract: StrategyContract;
  candidateParameters: Record<string, number>;
  bars: ServiceBar[];
  config: ServiceBacktestConfig;
  blindStartTime: number;
}

export interface BlindServiceResponse {
  schemaVersion: typeof BLIND_CONTRACT_VERSION;
  outcome: BlindTestOutcome;
  executionMs: number;
}

export const MATERIALIZE_CONTRACT_VERSION = "materialize-1.0" as const;

/** Rewrites the base program so the given parameter values hold; used to mint the parameter version's real source. */
export interface MaterializeRequest {
  schemaVersion: typeof MATERIALIZE_CONTRACT_VERSION;
  source: string;
  contract: StrategyContract;
  parameters: Record<string, number>;
}

export interface MaterializeResponse {
  schemaVersion: typeof MATERIALIZE_CONTRACT_VERSION;
  source: string;
}
