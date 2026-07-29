export type ContractTimeframe = "1m" | "15m" | "1h" | "4h";

export interface ContractDecision {
  type: "open" | "close";
  side: "long" | "short" | null;
  sizeKind: "riskPercent" | "fixedNotional" | null;
  sizeValue: number | null;
  stopLossPercent: number | null;
  takeProfitRiskReward: number | null;
}

export interface ContractRule {
  when: string[];
  decision: ContractDecision;
}

/**
 * A deliberately small audit contract. It is not the execution language.
 * Conditions use a canonical, machine-produced notation documented in prompt.ts.
 */
export interface StrategyContract {
  schemaVersion: "1.0";
  timeframe: ContractTimeframe;
  rules: ContractRule[];
  unsupportedCapabilities: string[];
}

export interface SemanticDiagnostic {
  code: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface ExtractedStrategySemantics {
  rules: ContractRule[];
  opaqueConditions: string[];
}

export interface SemanticScenarioResult {
  name: string;
  passed: boolean;
  expected: ContractDecision;
  actualType: string;
  diagnostics: SemanticDiagnostic[];
}

export interface SemanticVerificationReport {
  ok: boolean;
  contract: StrategyContract;
  extracted: ExtractedStrategySemantics;
  diagnostics: SemanticDiagnostic[];
  scenarios: SemanticScenarioResult[];
}

export function canonicalDecision(decision: ContractDecision): string {
  return JSON.stringify({
    type: decision.type,
    side: decision.side,
    sizeKind: decision.sizeKind,
    sizeValue: decision.sizeValue,
    stopLossPercent: decision.stopLossPercent,
    takeProfitRiskReward: decision.takeProfitRiskReward,
  });
}

function compactCondition(value: string): string {
  let result = "";
  let quoted = false;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      result += character;
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (!quoted && /\s/.test(character)) continue;
    result += character;
  }
  return result;
}

export function canonicalRule(rule: ContractRule): string {
  return JSON.stringify({
    when: rule.when.map(compactCondition).sort(),
    decision: JSON.parse(canonicalDecision(rule.decision)) as ContractDecision,
  });
}

export function normalizeContract(contract: StrategyContract): StrategyContract {
  return {
    ...contract,
    rules: contract.rules
      .map((rule) => ({ ...rule, when: [...new Set(rule.when)].sort() }))
      .sort((left, right) => canonicalRule(left).localeCompare(canonicalRule(right))),
    unsupportedCapabilities: [...new Set(contract.unsupportedCapabilities)].sort(),
  };
}

export function readyContract(timeframe: ContractTimeframe, rules: ContractRule[]): StrategyContract {
  return normalizeContract({
    schemaVersion: "1.0",
    timeframe,
    rules,
    unsupportedCapabilities: [],
  });
}
