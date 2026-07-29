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
