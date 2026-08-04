import type { SourceDiagnostic } from "../compiler/validate-strategy-source.js";
import type { StrategyContract } from "../semantics/contract.js";
import type { StrategyCapability } from "../semantics/capabilities.js";

export const VERIFY_CONTRACT_VERSION = "verify-1.0" as const;

export interface VerifyServiceRequest {
  schemaVersion: typeof VERIFY_CONTRACT_VERSION;
  /** The `defineStrategy({...})` program the strategy will actually run as. */
  source: string;
  /** The audit contract the model claimed; verified against the program. */
  contract: StrategyContract;
  /**
   * Capabilities the caller's data pipeline can actually feed the engine.
   * Any capability the program needs that is missing here is reported as
   * `unsupported` so the caller can intercept at analyze time instead of
   * failing at backtest time. Defaults to OHLCV + indicators + multi-timeframe
   * + state + arithmetic when omitted.
   */
  availableCapabilities?: StrategyCapability[];
}

export interface VerifyCompileResult {
  ok: boolean;
  diagnostics: SourceDiagnostic[];
}

export interface VerifyServiceResponse {
  schemaVersion: typeof VERIFY_CONTRACT_VERSION;
  /** True only when the program compiles, matches the contract, passes its
   *  behavioral scenarios, and needs no capability the caller lacks. */
  ok: boolean;
  compiled: VerifyCompileResult;
  /** Program ↔ contract reverse extraction + positive/negative scenario run. */
  semantics: {
    ok: boolean;
    diagnostics: Array<{ code: string; message: string }>;
    scenarioCount: number;
    scenarioPassed: number;
  };
  capabilities: {
    used: StrategyCapability[];
    unsupported: StrategyCapability[];
  };
  /** Flat list of every blocking finding (compile + semantics + capability). */
  diagnostics: Array<{ code: string; message: string }>;
}

export const DEFAULT_AVAILABLE_CAPABILITIES: StrategyCapability[] = [
  "ohlcv",
  "indicators",
  "multiTimeframe",
  "state",
  "arithmetic",
];
