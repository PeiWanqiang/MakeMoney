export {
  BACKTEST_CONTRACT_VERSION,
  type BacktestServiceRequest,
  type BacktestServiceResponse,
  type ServiceBar,
  type ServiceBacktestConfig,
  type ServiceTimeframe,
  type ServiceTimeframeContext,
} from "./backtest.js";

export {
  VERIFY_CONTRACT_VERSION,
  DEFAULT_AVAILABLE_CAPABILITIES,
  type VerifyCompileResult,
  type VerifyServiceRequest,
  type VerifyServiceResponse,
} from "./verify.js";

export {
  BLIND_CONTRACT_VERSION,
  MATERIALIZE_CONTRACT_VERSION,
  OPTIMIZATION_CONTRACT_VERSION,
  type BlindServiceRequest,
  type BlindServiceResponse,
  type MaterializeRequest,
  type MaterializeResponse,
  type OptimizationObjective,
  type OptimizationServiceRequest,
  type OptimizationServiceResponse,
} from "./optimization.js";

export type { StrategyCapability } from "../semantics/capabilities.js";
export type {
  BlindCheck,
  BlindTestInput,
  BlindTestOutcome,
} from "../optimization/blind-test.js";
export type {
  OptimizationCoreResult,
  OptimizationInput,
  OptimizationMetrics,
  OptimizationTrial,
  RobustnessGate,
} from "../optimization/optimization.js";
