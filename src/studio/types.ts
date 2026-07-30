import type { SourceDiagnostic } from "../compiler/validate-strategy-source.js";
import type { BacktestMetrics } from "../runtime/backtest-metrics.js";
import type { SemanticVerificationReport, StrategyContract } from "../semantics/contract.js";

export type StrategyGenerationMode = "create" | "revise" | "repair";

export interface StrategyModelArtifact {
  status: "ready" | "needs_clarification" | "unsupported";
  source: string;
  contract: StrategyContract;
  clarificationQuestions?: string[];
  explanation: string;
  assumptions: string[];
  warnings: string[];
  changeSummary: string;
}

export interface StrategyProviderRequest {
  mode: StrategyGenerationMode;
  sessionId: string;
  userIntent: string;
  originalIntent: string;
  attempt: number;
  currentSource?: string;
  compilerDiagnostics?: SourceDiagnostic[];
}

export interface StrategyProviderResponse {
  artifact: StrategyModelArtifact;
  provider: string;
  model: string;
  responseId?: string;
  usage?: ProviderTokenUsage;
}

export interface ProviderTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  uncachedInputTokens?: number;
  reasoningTokens?: number;
}

export interface StrategyProgramProvider {
  generate(request: StrategyProviderRequest): Promise<StrategyProviderResponse>;
}

export interface StrategyEvaluation {
  evaluationId: string;
  reportPath?: string;
  datasetId: string;
  interval: string;
  sourceRows: number;
  evaluatedBars: number;
  metrics: BacktestMetrics;
  initialCapital: number;
  finalEquity: number;
}

export interface StrategyEvaluator {
  evaluate(source: string): Promise<StrategyEvaluation>;
}

export interface CompilationAttempt {
  attempt: number;
  mode: StrategyGenerationMode;
  provider: string;
  model: string;
  responseId?: string;
  source: string;
  diagnostics: SourceDiagnostic[];
}

export interface StrategySourceDiff {
  added: string[];
  removed: string[];
}

export interface StrategyVersionArtifact {
  schemaVersion: "1.0";
  versionId: string;
  sessionId: string;
  ordinal: number;
  parentVersionId: string | null;
  createdAt: string;
  originalIntent: string;
  userIntent: string;
  source: string;
  sourceHash: string;
  contract: StrategyContract;
  semanticVerification: SemanticVerificationReport;
  explanation: string;
  assumptions: string[];
  warnings: string[];
  changeSummary: string;
  sourceDiff: StrategySourceDiff;
  generation: {
    provider: string;
    model: string;
    responseId?: string;
    repairCount: number;
    usage?: ProviderTokenUsage;
  };
  failedCompilationAttempts: CompilationAttempt[];
  evaluation?: StrategyEvaluation;
}

export interface StrategySession {
  schemaVersion: "1.0";
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  originalIntent: string;
  versionIds: string[];
}
