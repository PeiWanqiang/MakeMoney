import { compileStrategySource } from "../compiler/compile-strategy-source.js";
import type { RuntimePosition, StrategyDecision } from "../core/types.js";
import { StrategySandboxSession, type StrategySemanticScenario } from "../runtime/sandbox.js";
import {
  canonicalDecision,
  type ContractDecision,
  type ContractRule,
  type SemanticDiagnostic,
  type SemanticScenarioResult,
  type StrategyContract,
} from "./contract.js";

function splitTopLevel(value: string): string[] {
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
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim());
}

function isIndicator(value: string): boolean {
  return /^(sma|ema|highest|lowest|percentChange|standardDeviation|rsi|atr|macd|bollingerBands)\(/.test(value);
}

function compactOperand(value: string): string {
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

function setOperand(scenario: StrategySemanticScenario, rawOperand: string, value: number | string): void {
  const operand = compactOperand(rawOperand);
  const timeframe = /^timeframe\("(1m|15m|1h|4h)"\)\.(.+)$/.exec(operand);
  if (timeframe) {
    scenario.timeframes ??= {};
    const interval = timeframe[1] as "1m" | "15m" | "1h" | "4h";
    const frame = scenario.timeframes[interval] ?? { market: {}, indicators: {} };
    const nested: StrategySemanticScenario = {
      ...(frame.market === undefined ? {} : { market: frame.market }),
      ...(frame.indicators === undefined ? {} : { indicators: frame.indicators }),
    };
    setOperand(nested, timeframe[2] ?? "", value);
    scenario.timeframes[interval] = {
      ...(nested.market === undefined ? {} : { market: nested.market }),
      ...(nested.indicators === undefined ? {} : { indicators: nested.indicators }),
    };
    return;
  }
  if (isIndicator(operand)) {
    scenario.indicators ??= {};
    const property = /^(.*\))\.(macd|signal|histogram|middle|upper|lower)$/.exec(operand);
    if (property) {
      const key = property[1] ?? operand;
      const current = scenario.indicators[key];
      const object = current && typeof current === "object" && !Array.isArray(current) ? current : {};
      scenario.indicators[key] = { ...object, [property[2] ?? "value"]: typeof value === "number" ? value : Number(value) };
    } else {
      scenario.indicators[operand] = typeof value === "number" ? value : Number(value);
    }
    return;
  }
  const [section, field] = operand.split(".");
  if (section === "market" && field) {
    scenario.market ??= {};
    (scenario.market as Record<string, unknown>)[field] = value;
  } else if (section === "position" && field === "side") {
    scenario.position ??= {};
    scenario.position.side = value as RuntimePosition["side"];
  } else if (section === "account" && field === "equity" && typeof value === "number") {
    scenario.equity = value;
  } else if (section === "state" && field) {
    scenario.state ??= {};
    scenario.state[field] = value;
  }
}

function parsedLiteral(value: string): number | string | undefined {
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value) as string;
  return undefined;
}

function comparisonValues(operator: string, satisfied: boolean): [number, number] {
  if (satisfied) {
    if (operator === ">" || operator === ">=") return [2, 1];
    if (operator === "<" || operator === "<=") return [0, 1];
    if (operator === "==") return [1, 1];
    return [2, 1];
  }
  if (operator === ">" || operator === ">=") return [0, 1];
  if (operator === "<" || operator === "<=") return [2, 1];
  if (operator === "==") return [2, 1];
  return [1, 1];
}

function applyCondition(scenario: StrategySemanticScenario, condition: string, satisfied: boolean): boolean {
  const cross = /^(crossAbove|crossBelow)\((.*)\)$/.exec(condition);
  if (cross) {
    const args = splitTopLevel(cross[2] ?? "");
    if (args.length !== 4) return false;
    const above = cross[1] === "crossAbove";
    const values = satisfied
      ? above ? [3, 1, 2, 2] : [1, 3, 2, 2]
      : above ? [1, 3, 2, 2] : [3, 1, 2, 2];
    args.forEach((operand, index) => setOperand(scenario, operand, values[index] ?? 0));
    return true;
  }
  const comparison = /^(.+?)(==|!=|<=|>=|<|>)(.+)$/.exec(condition);
  if (!comparison) return false;
  const left = comparison[1]?.trim() ?? "";
  const operator = comparison[2] ?? "";
  const right = comparison[3]?.trim() ?? "";
  const literal = parsedLiteral(right);
  if (literal !== undefined) {
    if (typeof literal === "string") {
      setOperand(scenario, left, satisfied === (operator === "==") ? literal : literal === "flat" ? "long" : "flat");
      return true;
    }
    const delta = Math.max(1, Math.abs(literal) * 0.1);
    const candidate = operator === ">" || operator === ">="
      ? satisfied ? literal + delta : literal - delta
      : operator === "<" || operator === "<="
        ? satisfied ? literal - delta : literal + delta
        : satisfied === (operator === "==") ? literal : literal + delta;
    setOperand(scenario, left, candidate);
    return true;
  }
  const [leftValue, rightValue] = comparisonValues(operator, satisfied);
  setOperand(scenario, left, leftValue);
  setOperand(scenario, right, rightValue);
  return true;
}

function expectedDecision(actual: StrategyDecision): ContractDecision | undefined {
  if (actual.type === "hold") return undefined;
  if (actual.type === "close") {
    return { type: "close", side: null, sizeKind: null, sizeValue: null, stopLossPercent: null, takeProfitRiskReward: null };
  }
  return {
    type: "open",
    side: actual.side,
    sizeKind: actual.size.kind,
    sizeValue: actual.size.value,
    stopLossPercent: actual.stopLossPercent,
    takeProfitRiskReward: actual.takeProfitRiskReward ?? null,
  };
}

function indicatorOperands(contract: StrategyContract): string[] {
  const operands = new Set<string>();
  const pattern = /(?:timeframe\("(?:1m|15m|1h|4h)"\)\.)?(?:sma|ema|highest|lowest|percentChange|standardDeviation|rsi|atr|macd|bollingerBands)\([^)]*\)(?:\.(?:macd|signal|histogram|middle|upper|lower))?/g;
  for (const rule of contract.rules) {
    for (const condition of rule.when) {
      for (const match of condition.matchAll(pattern)) operands.add(match[0]);
    }
  }
  return [...operands];
}

function baseScenario(rule: ContractRule, contract: StrategyContract): StrategySemanticScenario {
  const scenario: StrategySemanticScenario = {
    market: { timestamp: 0, open: 100, high: 101, low: 99, close: 100, volume: 1_000, fundingRate: 0, openInterest: 1_000_000 },
    position: {
      side: rule.decision.type === "close" ? "long" : "flat",
      quantity: rule.decision.type === "close" ? 1 : 0,
      entryPrice: rule.decision.type === "close" ? 100 : null,
      stopPrice: null,
      takeProfitPrice: null,
      unrealizedPnl: 0,
    },
    equity: 10_000,
    state: {},
    indicators: {},
  };
  // A real strategy commonly calculates several indicators before branching.
  // Initialize every indicator in the contract so a null guard unrelated to the
  // condition under test cannot turn a valid semantic scenario into a false hold.
  for (const operand of indicatorOperands(contract)) setOperand(scenario, operand, 1);
  return scenario;
}

async function runRuleScenario(
  session: StrategySandboxSession,
  rule: ContractRule,
  ruleIndex: number,
  contract: StrategyContract,
  negativeConditionIndex?: number,
): Promise<SemanticScenarioResult> {
  const scenario = baseScenario(rule, contract);
  const unsupported: string[] = [];
  rule.when.forEach((condition, index) => {
    if (!applyCondition(scenario, condition, index !== negativeConditionIndex)) unsupported.push(condition);
  });
  const result = await session.runSemanticScenario(scenario);
  const actual = expectedDecision(result.decision);
  const positive = negativeConditionIndex === undefined;
  const passed = unsupported.length === 0 && (positive
    ? actual !== undefined && canonicalDecision(actual) === canonicalDecision(rule.decision)
    : actual === undefined || canonicalDecision(actual) !== canonicalDecision(rule.decision));
  const diagnostics: SemanticDiagnostic[] = [];
  if (unsupported.length > 0) diagnostics.push({ code: "UNSUPPORTED_SCENARIO_CONDITION", message: unsupported.join(", ") });
  if (!passed && unsupported.length === 0) diagnostics.push({
    code: positive ? "SCENARIO_DECISION_MISMATCH" : "NEGATIVE_SCENARIO_TRIGGERED",
    message: positive ? "Program decision did not match the contract." : "Program still emitted the target decision after one condition was falsified.",
    expected: canonicalDecision(rule.decision),
    actual: actual ? canonicalDecision(actual) : result.decision.type,
  });
  return {
    name: positive ? `rule-${ruleIndex + 1}-positive` : `rule-${ruleIndex + 1}-negative-${(negativeConditionIndex ?? 0) + 1}`,
    passed,
    expected: rule.decision,
    actualType: result.decision.type,
    diagnostics,
  };
}

export async function runContractScenarios(source: string, contract: StrategyContract): Promise<SemanticScenarioResult[]> {
  const session = await StrategySandboxSession.create(compileStrategySource(source));
  const results: SemanticScenarioResult[] = [];
  try {
    for (let ruleIndex = 0; ruleIndex < contract.rules.length; ruleIndex += 1) {
      const rule = contract.rules[ruleIndex];
      if (!rule) continue;
      results.push(await runRuleScenario(session, rule, ruleIndex, contract));
      for (let conditionIndex = 0; conditionIndex < rule.when.length; conditionIndex += 1) {
        results.push(await runRuleScenario(session, rule, ruleIndex, contract, conditionIndex));
      }
    }
  } finally {
    session.dispose();
  }
  return results;
}
