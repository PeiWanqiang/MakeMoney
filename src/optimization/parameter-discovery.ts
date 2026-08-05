import type { ContractValue, StrategyContract } from "../semantics/contract.js";

/**
 * Parameter discovery and application for the parameter lab. This is a faithful
 * port of the Web's `web/worker/backtest-api.ts` logic: numbers are discovered
 * from the machine contract (the canonical audit record), and each parameter is
 * addressed by a contract-relative id (`rule.N.when.M.number.K` for condition
 * thresholds/periods, `rule.N.decision.<field>` for sizing/stop/take-profit).
 * Keeping the ids identical preserves the browser parameter schema across the
 * migration to the service.
 */

export type ParameterKind = "integer" | "number";
export type ParameterUnit = "bars" | "ratio" | "riskReward" | "quote" | "value";

export interface NumberToken {
  start: number;
  end: number;
  value: number;
}

export type ParameterTarget =
  | { kind: "conditionNumber"; ruleIndex: number; conditionIndex: number; numberIndex: number }
  | { kind: "decisionField"; ruleIndex: number; field: "sizeValue" | "stopLossPercent" | "takeProfitRiskReward" };

export interface ParameterDefinition {
  id: string;
  label: string;
  context: string;
  value: number;
  kind: ParameterKind;
  unit: ParameterUnit;
  suggestedMin: number;
  suggestedMax: number;
  suggestedSteps: number;
  hardMin: number;
  hardMax: number;
  target: ParameterTarget;
}

export interface PublicParameterDefinition extends Omit<ParameterDefinition, "target" | "hardMin" | "hardMax"> {
  hardBounds: { min: number; max: number };
}

export interface ParameterSelection {
  id: string;
  min: number;
  max: number;
  steps: number;
}

export function numberTokens(expression: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < expression.length;) {
    const character = expression[index]!;
    if (escaped) {
      escaped = false;
      index += 1;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      index += 1;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      index += 1;
      continue;
    }
    if (quoted || !/[\d.]/.test(character)) {
      index += 1;
      continue;
    }
    const previous = expression[index - 1] ?? "";
    if (/[A-Za-z0-9_.]/.test(previous)) {
      index += 1;
      continue;
    }
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(expression.slice(index));
    if (!match) {
      index += 1;
      continue;
    }
    const end = index + match[0].length;
    const next = expression[end] ?? "";
    if (/[A-Za-z0-9_]/.test(next)) {
      index = end;
      continue;
    }
    const value = Number(match[0]);
    if (Number.isFinite(value)) tokens.push({ start: index, end, value });
    index = end;
  }
  return tokens;
}

export function callArgumentContext(expression: string, token: NumberToken): { name: string; argumentIndex: number } | null {
  const stack: Array<{ name: string; open: number }> = [];
  let quoted = false;
  for (let index = 0; index < token.start; index += 1) {
    const character = expression[index]!;
    if (character === '"' && expression[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") {
      const prefix = expression.slice(0, index).match(/([A-Za-z][A-Za-z0-9]*)\s*$/);
      stack.push({ name: prefix?.[1] ?? "", open: index });
    } else if (character === ")") stack.pop();
  }
  const active = stack.at(-1);
  if (!active?.name) return null;
  let argumentIndex = 0;
  let depth = 0;
  quoted = false;
  for (let index = active.open + 1; index < token.start; index += 1) {
    const character = expression[index]!;
    if (character === '"' && expression[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) argumentIndex += 1;
  }
  return { name: active.name, argumentIndex };
}

export function isLagArgument(context: { name: string; argumentIndex: number } | null): boolean {
  if (!context) return false;
  const lagIndex: Record<string, number> = { sma: 2, ema: 2, rsi: 2, highest: 2, lowest: 2, percentChange: 2, atr: 1, bollingerBands: 3, macd: 4 };
  return lagIndex[context.name] === context.argumentIndex;
}

export function isPeriodArgument(context: { name: string; argumentIndex: number } | null): boolean {
  if (!context) return false;
  if (["sma", "ema", "rsi", "highest", "lowest", "percentChange", "bollingerBands", "macd"].includes(context.name)) {
    return context.argumentIndex === 1 || (context.name === "macd" && [2, 3].includes(context.argumentIndex));
  }
  return context.name === "atr" && context.argumentIndex === 0;
}

export function isArithmeticIdentity(expression: string, token: NumberToken, context: { name: string; argumentIndex: number } | null): boolean {
  if (context || ![0, 1].includes(token.value)) return false;
  const before = expression.slice(0, token.start).trimEnd().at(-1) ?? "";
  const after = expression.slice(token.end).trimStart().at(0) ?? "";
  return ("(+-*/".includes(before) && "+-*/".includes(after))
    || ("+-*/".includes(before) && ")".includes(after));
}

export function parameterRange(value: number, kind: ParameterKind, unit: ParameterUnit): Pick<ParameterDefinition, "suggestedMin" | "suggestedMax" | "suggestedSteps" | "hardMin" | "hardMax"> {
  if (unit === "bars") {
    const minimum = Math.max(1, Math.floor(value * 0.5));
    const maximum = Math.min(1000, Math.max(minimum + 2, Math.ceil(value * 1.5)));
    return { suggestedMin: minimum, suggestedMax: maximum, suggestedSteps: 5, hardMin: 1, hardMax: 1000 };
  }
  if (unit === "riskReward") {
    return { suggestedMin: Math.max(0.25, value * 0.5), suggestedMax: Math.min(20, Math.max(0.5, value * 1.5)), suggestedSteps: 5, hardMin: 0.1, hardMax: 20 };
  }
  if (unit === "ratio") {
    return { suggestedMin: Math.max(0.001, value * 0.5), suggestedMax: Math.min(1, Math.max(0.01, value * 1.5)), suggestedSteps: 5, hardMin: 0.001, hardMax: 1 };
  }
  if (unit === "quote") {
    return { suggestedMin: Math.max(1, value * 0.5), suggestedMax: Math.min(100_000_000, Math.max(2, value * 1.5)), suggestedSteps: 5, hardMin: 1, hardMax: 100_000_000 };
  }
  const magnitude = Math.max(Math.abs(value), 0.01);
  const lower = value >= 0 ? Math.max(0, value - magnitude * 0.5) : value - magnitude * 0.5;
  const upper = value + magnitude * 0.5;
  return {
    suggestedMin: kind === "integer" ? Math.floor(lower) : lower,
    suggestedMax: kind === "integer" ? Math.ceil(Math.max(lower + 1, upper)) : upper,
    suggestedSteps: 5,
    hardMin: -1_000_000_000,
    hardMax: 1_000_000_000,
  };
}

export function extractParameterSchema(contract: StrategyContract): ParameterDefinition[] {
  const parameters: ParameterDefinition[] = [];
  contract.rules.forEach((rule, ruleIndex) => {
    rule.when.forEach((condition, conditionIndex) => {
      numberTokens(condition).forEach((token, numberIndex) => {
        const call = callArgumentContext(condition, token);
        if (isLagArgument(call) || isArithmeticIdentity(condition, token, call)) return;
        const period = isPeriodArgument(call);
        const kind: ParameterKind = period ? "integer" : Number.isInteger(token.value) && Math.abs(token.value) >= 2 ? "integer" : "number";
        const unit: ParameterUnit = period ? "bars" : "value";
        const range = parameterRange(token.value, kind, unit);
        const role = period ? `${call?.name ?? "指标"} 周期` : `条件数值 ${numberIndex + 1}`;
        parameters.push({
          id: `rule.${ruleIndex}.when.${conditionIndex}.number.${numberIndex}`,
          label: `规则 ${ruleIndex + 1} · ${role}`,
          context: condition,
          value: token.value,
          kind,
          unit,
          ...range,
          target: { kind: "conditionNumber", ruleIndex, conditionIndex, numberIndex },
        });
      });
    });
    if (rule.decision.type !== "open") return;
    const decisionParameters: Array<{ field: "sizeValue" | "stopLossPercent" | "takeProfitRiskReward"; label: string; unit: ParameterUnit; value: ContractValue }> = [
      { field: "sizeValue", label: "开仓仓位", unit: rule.decision.sizeKind === "fixedNotional" ? "quote" : "ratio", value: rule.decision.sizeValue },
      { field: "stopLossPercent", label: "止损距离", unit: "ratio", value: rule.decision.stopLossPercent },
      { field: "takeProfitRiskReward", label: "止盈风险回报比", unit: "riskReward", value: rule.decision.takeProfitRiskReward },
    ];
    // A field that computes its value is deliberately not offered as a tunable
    // number: replacing the expression with one would discard the calculation the
    // customer confirmed. Its own constants stay adjustable through the program.
    for (const item of decisionParameters) {
      if (typeof item.value !== "number" || !Number.isFinite(item.value)) continue;
      parameters.push({
        id: `rule.${ruleIndex}.decision.${item.field}`,
        label: `规则 ${ruleIndex + 1} · ${item.label}`,
        context: `${rule.decision.side === "long" ? "做多" : "做空"} · ${rule.decision.sizeKind}`,
        value: item.value,
        kind: "number",
        unit: item.unit,
        ...parameterRange(item.value, "number", item.unit),
        target: { kind: "decisionField", ruleIndex, field: item.field },
      });
    }
  });
  return parameters;
}

export function semanticSkeleton(contract: StrategyContract): string {
  const clone = structuredClone(contract);
  const parameters = extractParameterSchema(contract);
  contract.rules.forEach((rule, ruleIndex) => {
    rule.when.forEach((expression, conditionIndex) => {
      const indices = parameters.flatMap((parameter) => parameter.target.kind === "conditionNumber"
        && parameter.target.ruleIndex === ruleIndex && parameter.target.conditionIndex === conditionIndex
        ? [parameter.target.numberIndex]
        : []);
      const tokens = numberTokens(expression);
      let skeleton = expression;
      for (const numberIndex of indices.sort((left, right) => right - left)) {
        const token = tokens[numberIndex];
        if (!token) throw new Error(`规则 ${ruleIndex + 1} 的参数位置已失效`);
        skeleton = `${skeleton.slice(0, token.start)}{PARAM}${skeleton.slice(token.end)}`;
      }
      clone.rules[ruleIndex]!.when[conditionIndex] = skeleton;
    });
  });
  for (const parameter of parameters) {
    if (parameter.target.kind === "decisionField") {
      const decision = clone.rules[parameter.target.ruleIndex]!.decision as unknown as Record<string, unknown>;
      decision[parameter.target.field] = "{PARAM}";
    }
  }
  return JSON.stringify(clone);
}

export function replaceConditionNumber(expression: string, numberIndex: number, value: number): string {
  const token = numberTokens(expression)[numberIndex];
  if (!token) throw new Error("策略参数位置已经失效");
  return `${expression.slice(0, token.start)}${String(value)}${expression.slice(token.end)}`;
}

export function applyParameters(contract: StrategyContract, definitions: ParameterDefinition[], values: Record<string, number>): StrategyContract {
  const clone = structuredClone(contract);
  const conditionUpdates = new Map<string, Array<{ numberIndex: number; value: number }>>();
  for (const [id, value] of Object.entries(values)) {
    const definition = definitions.find((item) => item.id === id);
    if (!definition) throw new Error(`未知策略参数 ${id}`);
    const normalized = definition.kind === "integer" ? Math.round(value) : value;
    if (!Number.isFinite(normalized) || normalized < definition.hardMin || normalized > definition.hardMax) {
      throw new Error(`参数 ${definition.label} 超出安全范围`);
    }
    if (definition.target.kind === "conditionNumber") {
      const { ruleIndex, conditionIndex, numberIndex } = definition.target;
      const key = `${ruleIndex}:${conditionIndex}`;
      const updates = conditionUpdates.get(key) ?? [];
      updates.push({ numberIndex, value: normalized });
      conditionUpdates.set(key, updates);
    } else {
      const decision = clone.rules[definition.target.ruleIndex]!.decision as unknown as Record<string, unknown>;
      decision[definition.target.field] = normalized;
    }
  }
  for (const [key, updates] of conditionUpdates) {
    const [ruleIndex, conditionIndex] = key.split(":").map((part) => Number(part)) as [number, number];
    let expression = clone.rules[ruleIndex]!.when[conditionIndex]!;
    for (const update of updates.sort((left, right) => right.numberIndex - left.numberIndex)) {
      expression = replaceConditionNumber(expression, update.numberIndex, update.value);
    }
    clone.rules[ruleIndex]!.when[conditionIndex] = expression;
  }
  return clone;
}

export function parameterLevels(definition: ParameterDefinition, selection: ParameterSelection): number[] {
  const values = Array.from({ length: selection.steps }, (_, index) => {
    const raw = selection.min + (selection.max - selection.min) * index / Math.max(1, selection.steps - 1);
    return definition.kind === "integer" ? Math.round(raw) : Number(raw.toPrecision(12));
  });
  values.push(definition.value);
  return [...new Set(values)].sort((left, right) => left - right);
}

export function generateParameterCandidates(
  definitions: ParameterDefinition[],
  selections: ParameterSelection[],
  maximumTrials: number,
): Array<Record<string, number>> {
  const selected = selections.map((selection) => {
    const definition = definitions.find((item) => item.id === selection.id)!;
    return { definition, levels: parameterLevels(definition, selection) };
  });
  const combinations: Array<Record<string, number>> = [];
  const visit = (index: number, current: Record<string, number>): void => {
    if (index === selected.length) {
      combinations.push({ ...current });
      return;
    }
    const parameter = selected[index]!;
    for (const value of parameter.levels) {
      current[parameter.definition.id] = value;
      visit(index + 1, current);
    }
  };
  visit(0, {});
  const baseline = Object.fromEntries(selected.map(({ definition }) => [definition.id, definition.value]));
  const baselineKey = JSON.stringify(baseline);
  const alternatives = combinations.filter((candidate) => JSON.stringify(candidate) !== baselineKey);
  if (alternatives.length <= maximumTrials - 1) return [baseline, ...alternatives];
  const sampled: Array<Record<string, number>> = [baseline];
  const used = new Set<number>();
  for (let index = 0; index < maximumTrials - 1; index += 1) {
    const position = Math.floor(index * (alternatives.length - 1) / Math.max(1, maximumTrials - 2));
    if (!used.has(position)) {
      used.add(position);
      sampled.push(alternatives[position]!);
    }
  }
  return sampled.slice(0, maximumTrials);
}

export function publicParameter(parameter: ParameterDefinition): PublicParameterDefinition {
  return {
    id: parameter.id,
    label: parameter.label,
    context: parameter.context,
    value: parameter.value,
    kind: parameter.kind,
    unit: parameter.unit,
    suggestedMin: parameter.suggestedMin,
    suggestedMax: parameter.suggestedMax,
    suggestedSteps: parameter.suggestedSteps,
    hardBounds: { min: parameter.hardMin, max: parameter.hardMax },
  };
}
