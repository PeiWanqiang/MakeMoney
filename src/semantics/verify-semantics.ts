import { extractStrategySemantics } from "./extract-semantics.js";
import { runContractScenarios } from "./scenario-runner.js";
import {
  canonicalRule,
  normalizeContract,
  type SemanticDiagnostic,
  type SemanticVerificationReport,
  type StrategyContract,
} from "./contract.js";

export async function verifyStrategySemantics(
  source: string,
  inputContract: StrategyContract,
): Promise<SemanticVerificationReport> {
  const contract = normalizeContract(inputContract);
  const extracted = extractStrategySemantics(source);
  const diagnostics: SemanticDiagnostic[] = [];
  // `timeframe(...)` is for reading a *different* timeframe. Both engines build
  // views only for the intervals a contract names beside its own, so a program
  // that reaches for its own interval receives null on every bar and holds
  // forever — a strategy that backtests as a flat line rather than an error.
  // Extraction alone reports this as an unrelated pile of rule mismatches, which
  // is the shape of a disagreement, not the cause; naming it is what lets a
  // repair round fix it in one step.
  const selfPrefix = `timeframe("${contract.timeframe}").`;
  if (source.includes(`timeframe("${contract.timeframe}")`) || contract.rules.some((rule) => rule.when.some((when) => when.includes(selfPrefix)))) {
    diagnostics.push({
      code: "SELF_TIMEFRAME_VIEW",
      message: `The strategy already runs on ${contract.timeframe} bars: read them from context.market and context.indicators directly. context.timeframe("${contract.timeframe}") is null at run time and is only for a different timeframe.`,
    });
  }
  if (contract.unsupportedCapabilities.length > 0) {
    diagnostics.push({
      code: "UNSUPPORTED_CAPABILITIES",
      message: `Contract requires unsupported capabilities: ${contract.unsupportedCapabilities.join(", ")}`,
    });
  }
  for (const opaque of extracted.opaqueConditions) {
    diagnostics.push({ code: "OPAQUE_PROGRAM_CONDITION", message: `Cannot verify program condition '${opaque}'.` });
  }
  const expectedRules = new Set(contract.rules.map(canonicalRule));
  const actualRules = new Set(extracted.rules.map(canonicalRule));
  for (const expected of expectedRules) {
    if (!actualRules.has(expected)) diagnostics.push({ code: "MISSING_CONTRACT_RULE", message: "Program is missing a contracted rule.", expected });
  }
  for (const actual of actualRules) {
    if (!expectedRules.has(actual)) diagnostics.push({ code: "UNEXPECTED_PROGRAM_RULE", message: "Program contains a rule not present in the contract.", actual });
  }
  const scenarios = diagnostics.length === 0 ? await runContractScenarios(source, contract) : [];
  diagnostics.push(...scenarios.flatMap((scenario) => scenario.diagnostics));
  return {
    ok: diagnostics.length === 0 && scenarios.every((scenario) => scenario.passed),
    contract,
    extracted,
    diagnostics,
    scenarios,
  };
}
