import { compareStrategyContracts, type SemanticDiagnostic, type StrategyContract } from "../semantics/contract.js";
import type { InternetIntentGoldenRecord } from "./review.js";

export type InternetIntentActualAction = "ready" | "needs_clarification" | "unsupported" | "engine_error";

export interface InternetIntentActualResolution {
  action: InternetIntentActualAction;
  contract: StrategyContract | null;
  semanticVerified: boolean;
  mutationKillRate: number | null;
}

export interface InternetIntentOutcomeAssessment {
  status: "passed" | "action_matched_manual_review_required" | "first_action_mismatch" | "contract_mismatch" | "semantic_failure" | "mutation_failure" | "engine_error";
  actionMatched: boolean;
  strictPassed: boolean;
  requiresManualReview: boolean;
  contractDiagnostics: SemanticDiagnostic[];
}

export function assessGoldenOutcome(
  expected: InternetIntentGoldenRecord,
  actual: InternetIntentActualResolution,
): InternetIntentOutcomeAssessment {
  if (actual.action === "engine_error") return {
    status: "engine_error",
    actionMatched: false,
    strictPassed: false,
    requiresManualReview: false,
    contractDiagnostics: [],
  };
  if (actual.action !== expected.expectedFirstAction) return {
    status: "first_action_mismatch",
    actionMatched: false,
    strictPassed: false,
    requiresManualReview: false,
    contractDiagnostics: [],
  };
  if (expected.expectedFirstAction !== "ready") return {
    status: "action_matched_manual_review_required",
    actionMatched: true,
    strictPassed: false,
    requiresManualReview: true,
    contractDiagnostics: [],
  };
  if (!expected.contract || !actual.contract) return {
    status: "contract_mismatch",
    actionMatched: true,
    strictPassed: false,
    requiresManualReview: false,
    contractDiagnostics: [{ code: "MISSING_READY_CONTRACT", message: "A ready result must contain both expected and actual contracts." }],
  };
  const contractDiagnostics = compareStrategyContracts(expected.contract, actual.contract);
  if (contractDiagnostics.length > 0) return {
    status: "contract_mismatch",
    actionMatched: true,
    strictPassed: false,
    requiresManualReview: false,
    contractDiagnostics,
  };
  if (!actual.semanticVerified) return {
    status: "semantic_failure",
    actionMatched: true,
    strictPassed: false,
    requiresManualReview: false,
    contractDiagnostics: [],
  };
  if (actual.mutationKillRate !== 1) return {
    status: "mutation_failure",
    actionMatched: true,
    strictPassed: false,
    requiresManualReview: false,
    contractDiagnostics: [],
  };
  return {
    status: "passed",
    actionMatched: true,
    strictPassed: true,
    requiresManualReview: false,
    contractDiagnostics: [],
  };
}
