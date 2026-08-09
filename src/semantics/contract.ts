import { isTimeframe, TIMEFRAME_PATTERN, type Timeframe } from "../core/timeframes.js";
import { normalizeExpressionText } from "./expression.js";

export type ContractTimeframe = Timeframe;

/**
 * A quantified decision field: a constant, or an expression in the same grammar
 * the conditions use.
 *
 * Modelling these as bare numbers meant the contract could only quantify a stop
 * the model had already reduced to a literal, so a stop sized from ATR had no
 * representation at all and the intent had to be reported as unsupported. The
 * grammar that already describes conditions covers it without a new field per
 * pattern, and a constant stays a number so every stored contract still reads
 * back unchanged.
 */
export type ContractValue = number | string | null;

export interface ContractDecision {
  type: "open" | "close";
  side: "long" | "short" | null;
  sizeKind: "riskPercent" | "equityPercent" | "fixedNotional" | null;
  sizeValue: number | null;
  stopLossPercent: ContractValue;
  takeProfitRiskReward: ContractValue;
  /**
   * Share of the open position a close decision takes off, in (0,1], or null
   * for the whole position. A constant rather than an expression: a scale-out
   * the customer confirms as "half" has to stay half, and letting it compute
   * itself would put position sizing back inside the exit.
   *
   * Null on every open decision, and on contracts written before scale-out
   * existed, so an older stored contract still canonicalizes unchanged.
   */
  closeFraction: number | null;
}

/** Collapses an expression that is really a constant, so constants have one form. */
export function normalizeContractValue(value: ContractValue): ContractValue {
  if (typeof value !== "string") return value;
  const normalized = normalizeExpressionText(compactCondition(value));
  return /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(normalized) ? Number(normalized) : normalized;
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

/** Stable runtime rejection raised when a wire/model contract is malformed. */
export class StrategyContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategyContractValidationError";
  }
}

function contractError(message: string): never {
  throw new StrategyContractValidationError(message);
}

function finiteNumberOrNull(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) contractError(`${field} must be a finite number or null.`);
  return value;
}

function contractValue(value: unknown, field: string): ContractValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) contractError(`${field} must be finite.`);
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    contractError(`${field} must be a finite number, a non-empty expression, or null.`);
  }
  return value.trim();
}

function parseContractDecision(value: unknown, ruleIndex: number): ContractDecision {
  const label = `contract.rules[${ruleIndex}].decision`;
  if (!value || typeof value !== "object" || Array.isArray(value)) contractError(`${label} must be an object.`);
  const decision = value as Record<string, unknown>;
  if (decision.type !== "open" && decision.type !== "close") contractError(`${label}.type is invalid.`);

  const closeFraction = normalizeCloseFraction(finiteNumberOrNull(decision.closeFraction, `${label}.closeFraction`));
  if (closeFraction !== null && (closeFraction <= 0 || closeFraction > 1)) {
    contractError(`${label}.closeFraction must be greater than zero and at most one.`);
  }

  if (decision.type === "close") {
    for (const field of ["side", "sizeKind", "sizeValue", "stopLossPercent", "takeProfitRiskReward"] as const) {
      if (decision[field] !== undefined && decision[field] !== null) contractError(`${label}.${field} must be null for a close decision.`);
    }
    return {
      type: "close",
      side: null,
      sizeKind: null,
      sizeValue: null,
      stopLossPercent: null,
      takeProfitRiskReward: null,
      closeFraction,
    };
  }

  if (closeFraction !== null) contractError(`${label}.closeFraction must be null for an open decision.`);
  if (decision.side !== "long" && decision.side !== "short") contractError(`${label}.side is invalid.`);
  if (decision.sizeKind !== "riskPercent" && decision.sizeKind !== "equityPercent" && decision.sizeKind !== "fixedNotional") {
    contractError(`${label}.sizeKind is invalid.`);
  }
  const sizeValue = finiteNumberOrNull(decision.sizeValue, `${label}.sizeValue`);
  if (sizeValue === null || sizeValue <= 0) contractError(`${label}.sizeValue must be greater than zero.`);
  if (decision.sizeKind !== "fixedNotional" && sizeValue > 1) {
    contractError(`${label}.sizeValue must be at most one for percentage sizing.`);
  }
  const stopLossPercent = contractValue(decision.stopLossPercent, `${label}.stopLossPercent`);
  if (stopLossPercent === null) contractError(`${label}.stopLossPercent is required for an open decision.`);
  if (typeof stopLossPercent === "number" && (stopLossPercent <= 0 || stopLossPercent >= 1)) {
    contractError(`${label}.stopLossPercent must be between zero and one.`);
  }
  const takeProfitRiskReward = contractValue(decision.takeProfitRiskReward, `${label}.takeProfitRiskReward`);
  if (typeof takeProfitRiskReward === "number" && takeProfitRiskReward <= 0) {
    contractError(`${label}.takeProfitRiskReward must be greater than zero.`);
  }
  return {
    type: "open",
    side: decision.side,
    sizeKind: decision.sizeKind,
    sizeValue,
    stopLossPercent,
    takeProfitRiskReward,
    closeFraction: null,
  };
}

/**
 * Parses the one v1 contract boundary shared by model output and service APIs.
 *
 * Older stored contracts may omit fields whose historical meaning was null, so
 * the parser fills those nulls deterministically. It never repairs a malformed
 * trading value or invents a missing open-decision field.
 */
export function parseStrategyContract(value: unknown): StrategyContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) contractError("contract must be an object.");
  const contract = value as Record<string, unknown>;
  if (contract.schemaVersion !== "1.0") contractError("contract.schemaVersion must be '1.0'.");
  if (!isTimeframe(contract.timeframe)) contractError("contract.timeframe is invalid.");
  if (!Array.isArray(contract.rules)) contractError("contract.rules must be an array.");
  if (!Array.isArray(contract.unsupportedCapabilities)
    || !contract.unsupportedCapabilities.every((item) => typeof item === "string" && item.trim().length > 0)) {
    contractError("contract.unsupportedCapabilities must be an array of non-empty strings.");
  }

  const rules = contract.rules.map((valueRule, ruleIndex): ContractRule => {
    if (!valueRule || typeof valueRule !== "object" || Array.isArray(valueRule)) {
      return contractError(`contract.rules[${ruleIndex}] must be an object.`);
    }
    const rule = valueRule as Record<string, unknown>;
    if (!Array.isArray(rule.when) || rule.when.length === 0
      || !rule.when.every((condition) => typeof condition === "string" && condition.trim().length > 0)) {
      return contractError(`contract.rules[${ruleIndex}].when must contain non-empty conditions.`);
    }
    return {
      when: rule.when.map((condition) => (condition as string).trim()),
      decision: parseContractDecision(rule.decision, ruleIndex),
    };
  });

  return {
    schemaVersion: "1.0",
    timeframe: contract.timeframe,
    rules,
    unsupportedCapabilities: contract.unsupportedCapabilities.map((item) => (item as string).trim()),
  };
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
    stopLossPercent: normalizeContractValue(decision.stopLossPercent),
    takeProfitRiskReward: normalizeContractValue(decision.takeProfitRiskReward),
    closeFraction: normalizeCloseFraction(decision.closeFraction),
  });
}

/**
 * Collapses the two spellings of a whole-position exit. A program may return
 * `fraction: 1` and a contract may leave the field null; they mean the same
 * exit and have to compare equal.
 */
export function normalizeCloseFraction(value: number | null | undefined): number | null {
  return value === undefined || value === null || value === 1 ? null : value;
}

export function compactCondition(value: string): string {
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
  const comparison = findTopLevelRelationalComparison(result);
  if (!comparison) return result;
  // Arithmetic operands reach the contract as the model spelled them, so both
  // sides are re-emitted in canonical grouping before anything is compared.
  comparison.left = normalizeExpressionText(comparison.left);
  comparison.right = normalizeExpressionText(comparison.right);
  result = `${comparison.left}${comparison.operator}${comparison.right}`;
  if (comparison.left <= comparison.right) return result;
  const inverted = comparison.operator === "<"
    ? ">"
    : comparison.operator === ">"
      ? "<"
      : comparison.operator === "<="
        ? ">="
        : "<=";
  return `${comparison.right}${inverted}${comparison.left}`;
}

function findTopLevelRelationalComparison(value: string): {
  left: string;
  operator: "<" | ">" | "<=" | ">=";
  right: string;
} | undefined {
  const comparisons: Array<{ index: number; operator: "<" | ">" | "<=" | ">=" }> = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      continue;
    }
    if (depth !== 0 || (character !== "<" && character !== ">")) continue;
    const operator = value[index + 1] === "=" ? `${character}=` : character;
    comparisons.push({ index, operator: operator as "<" | ">" | "<=" | ">=" });
    if (operator.length === 2) index += 1;
  }
  if (comparisons.length !== 1) return undefined;
  const comparison = comparisons[0];
  if (!comparison) return undefined;
  const { index, operator } = comparison;
  const left = value.slice(0, index);
  const right = value.slice(index + operator.length);
  if (left.length === 0 || right.length === 0) return undefined;
  return { left, operator, right };
}

function splitConditionArguments(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"' && value[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

const TIMEFRAME_CROSS_PATTERN = new RegExp(
  `^timeframe\\("(${TIMEFRAME_PATTERN})"\\)\\.(crossAbove|crossBelow)\\((.*)\\)$`,
);

export function normalizeConditionNotation(input: string): string {
  let value = input.trim()
    .replace(/\bcontext\.indicators\./g, "")
    .replace(/\bindicators\./g, "")
    .replace(/\bcrossedAbove\s*\(/g, "crossAbove(")
    .replace(/\bcrossedBelow\s*\(/g, "crossBelow(");
  const timeframeCross = TIMEFRAME_CROSS_PATTERN.exec(value);
  if (timeframeCross) {
    const interval = timeframeCross[1] ?? "";
    const name = timeframeCross[2] ?? "";
    const argumentsText = timeframeCross[3] ?? "";
    const args = splitConditionArguments(argumentsText).map((argument) =>
      /^timeframe\(/.test(argument) ? argument : `timeframe("${interval}").${argument}`
    );
    value = `${name}(${args.join(",")})`;
  }
  return value;
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
      .map((rule) => ({ ...rule, when: [...new Set(rule.when.map(normalizeConditionNotation))].sort() }))
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

export function compareStrategyContracts(
  expectedInput: StrategyContract,
  actualInput: StrategyContract,
): SemanticDiagnostic[] {
  const expected = normalizeContract(expectedInput);
  const actual = normalizeContract(actualInput);
  const diagnostics: SemanticDiagnostic[] = [];
  if (actual.timeframe !== expected.timeframe) diagnostics.push({
    code: "CONTRACT_TIMEFRAME_MISMATCH",
    message: "Generated contract uses a different evaluation timeframe.",
    expected: expected.timeframe,
    actual: actual.timeframe,
  });
  if (actual.unsupportedCapabilities.length > 0) diagnostics.push({
    code: "UNEXPECTED_UNSUPPORTED_CAPABILITY",
    message: "Generated contract marked capabilities unsupported for a supported golden intent.",
    expected: "[]",
    actual: JSON.stringify(actual.unsupportedCapabilities),
  });
  const expectedRules = new Set(expected.rules.map(canonicalRule));
  const actualRules = new Set(actual.rules.map(canonicalRule));
  for (const rule of expectedRules) {
    if (!actualRules.has(rule)) diagnostics.push({
      code: "MISSING_GOLDEN_RULE",
      message: "Generated contract is missing a rule required by the golden intent.",
      expected: rule,
    });
  }
  for (const rule of actualRules) {
    if (!expectedRules.has(rule)) diagnostics.push({
      code: "UNEXPECTED_GENERATED_RULE",
      message: "Generated contract contains a rule not present in the golden intent.",
      actual: rule,
    });
  }
  return diagnostics;
}
