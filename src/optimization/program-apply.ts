import ts from "typescript";

import {
  canonicalRule,
  compactCondition,
  normalizeConditionNotation,
  type ContractDecision,
  type StrategyContract,
} from "../semantics/contract.js";
import type { ParameterDefinition } from "./parameter-discovery.js";

/**
 * Applies discovered parameter values to the REAL strategy program.
 *
 * The parameter lab discovers numbers on the contract (the audit record) but
 * must execute the actual TypeScript program. This module locates each
 * contract-relative parameter (`rule.N.when.M.number.K`, `rule.N.decision.*`)
 * inside the program's AST by matching canonical rules/conditions, then rewrites
 * the numeric literal at that exact source position. Everything else in the
 * program — variable hoisting, readiness guards, state — is preserved verbatim,
 * so a candidate differs from the base only in the tuned numbers.
 */

type Variables = Map<string, ts.Expression>;

export interface NumberSource {
  /** Absolute source position of the numeric literal; null when the canonical
   *  arg was defaulted in the program (e.g. an omitted indicator offset). */
  position: number | null;
  /** Length of the literal text, used for the rewrite span. */
  length: number;
  value: number;
}

interface Rendered {
  text: string;
  numbers: NumberSource[];
}

export interface ConditionNumbers {
  /** Canonical condition string (already prefix-normalized). */
  canonical: string;
  /** Numeric literals in `numberTokens(canonical)` order. */
  numbers: NumberSource[];
}

interface SourceBranch {
  /** canonicalRule() string used to match a contract rule. */
  canonicalRule: string;
  returnStatement: ts.ReturnStatement;
  conditions: ConditionNumbers[];
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
    if (propertyName(property.name) !== name) continue;
    return ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
  }
  return undefined;
}

function literal(node: ts.Expression | undefined): string | number | null | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (node.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return -Number(node.operand.text);
  }
  return undefined;
}

function resolve(node: ts.Expression, variables: Variables, seen = new Set<string>()): ts.Expression {
  if (!ts.isIdentifier(node) || seen.has(node.text)) return node;
  const replacement = variables.get(node.text);
  if (!replacement) return node;
  seen.add(node.text);
  return resolve(replacement, variables, seen);
}

function memberPath(node: ts.Expression): string[] | undefined {
  if (ts.isIdentifier(node)) return [node.text];
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const parent = memberPath(node.expression);
  return parent ? [...parent, node.name.text] : undefined;
}

function expandedMemberPath(node: ts.Expression, variables: Variables, seen = new Set<string>()): string[] | undefined {
  if (ts.isIdentifier(node)) {
    if (!seen.has(node.text)) {
      const replacement = variables.get(node.text);
      if (replacement) {
        seen.add(node.text);
        const expanded = expandedMemberPath(replacement, variables, seen);
        if (expanded) return expanded;
      }
    }
    return [node.text];
  }
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const parent = expandedMemberPath(node.expression, variables, seen);
  return parent ? [...parent, node.name.text] : undefined;
}

function indicatorCall(node: ts.CallExpression, variables: Variables): { name: string; interval?: string } | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const name = node.expression.name.text;
  const receiver = resolve(node.expression.expression, variables);
  if (!ts.isPropertyAccessExpression(receiver) || receiver.name.text !== "indicators") return undefined;
  const view = resolve(receiver.expression, variables);
  if (!ts.isCallExpression(view) || memberPath(view.expression)?.at(-1) !== "timeframe") return { name };
  const interval = literal(view.arguments[0]);
  return typeof interval === "string" ? { name, interval } : { name };
}

function isReadinessExpression(node: ts.Expression, variables: Variables): boolean {
  const resolved = resolve(node, variables);
  if (ts.isPrefixUnaryExpression(resolved) && resolved.operator === ts.SyntaxKind.ExclamationToken) {
    return isReadinessExpression(resolved.operand, variables);
  }
  if (ts.isCallExpression(resolved)) {
    return indicatorCall(resolved, variables) !== undefined || memberPath(resolved.expression)?.at(-1) === "timeframe";
  }
  if (!ts.isBinaryExpression(resolved)) return false;
  const comparable = operatorText(resolved.operatorToken.kind);
  if (comparable !== "==" && comparable !== "!=") return false;
  const leftNull = resolved.left.kind === ts.SyntaxKind.NullKeyword;
  const rightNull = resolved.right.kind === ts.SyntaxKind.NullKeyword;
  if (leftNull === rightNull) return false;
  return isReadinessExpression(leftNull ? resolved.right : resolved.left, variables);
}

function operatorText(kind: ts.SyntaxKind): string | undefined {
  const operators = new Map<ts.SyntaxKind, string>([
    [ts.SyntaxKind.EqualsEqualsEqualsToken, "=="],
    [ts.SyntaxKind.EqualsEqualsToken, "=="],
    [ts.SyntaxKind.ExclamationEqualsEqualsToken, "!="],
    [ts.SyntaxKind.ExclamationEqualsToken, "!="],
    [ts.SyntaxKind.LessThanToken, "<"],
    [ts.SyntaxKind.LessThanEqualsToken, "<="],
    [ts.SyntaxKind.GreaterThanToken, ">"],
    [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
  ]);
  return operators.get(kind);
}

function numericSource(node: ts.Expression, defaulted = false): NumberSource | undefined {
  if (defaulted) return { position: null, length: 0, value: 0 };
  if (ts.isNumericLiteral(node)) {
    return { position: node.getStart(), length: node.getEnd() - node.getStart(), value: Number(node.text) };
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    // numberTokens() reads the digit run without the sign, so the value is the
    // magnitude; the rewrite keeps the "-" prefix in place.
    return { position: node.operand.getStart(), length: node.operand.getEnd() - node.operand.getStart(), value: Number(node.operand.text) };
  }
  return undefined;
}

function defaultedNumber(): NumberSource {
  return { position: null, length: 0, value: 0 };
}

function renderOperand(node: ts.Expression, variables: Variables): Rendered | undefined {
  const resolved = resolve(node, variables);
  const value = literal(resolved);
  if (value !== undefined) {
    if (typeof value === "string") {
      if (value === "true" || value === "false") return { text: value, numbers: [] };
      return { text: JSON.stringify(value), numbers: [] };
    }
    const source = numericSource(resolved);
    return source ? { text: String(value), numbers: [source] } : undefined;
  }
  if (ts.isCallExpression(resolved)) {
    const indicator = indicatorCall(resolved, variables);
    const path = memberPath(resolved.expression);
    if (indicator) {
      const { name, interval } = indicator;
      const args = resolved.arguments.map((argument) => renderOperand(argument, variables));
      if (!args.every((argument) => argument !== undefined)) return undefined;
      const present = args as Rendered[];
      let normalized: Rendered[];
      if (["sma", "ema", "highest", "lowest", "standardDeviation", "rsi"].includes(name)) {
        normalized = [present[0] ?? { text: "", numbers: [] }, present[1] ?? { text: "", numbers: [] }, present[2] ?? { text: "0", numbers: [defaultedNumber()] }];
      } else if (name === "atr") {
        normalized = [present[0] ?? { text: "", numbers: [] }, present[1] ?? { text: "0", numbers: [defaultedNumber()] }];
      } else if (name === "macd") {
        const defaults = ["close", "12", "26", "9", "0"];
        normalized = defaults.map((fallback, index) => present[index] ?? { text: fallback, numbers: index === 4 ? [defaultedNumber()] : [] });
      } else if (name === "bollingerBands") {
        const defaults = ["close", "20", "2", "0"];
        normalized = defaults.map((fallback, index) => present[index] ?? { text: fallback, numbers: index === 3 ? [defaultedNumber()] : [] });
      } else {
        normalized = present;
      }
      const prefix = interval === undefined ? "" : `timeframe(${JSON.stringify(interval)}).`;
      return {
        text: `${prefix}${name}(${normalized.map((item) => item.text).join(",")})`,
        numbers: normalized.flatMap((item) => item.numbers),
      };
    }
    if (path?.at(-2) === "state" && path.at(-1) === "get") {
      const key = literal(resolved.arguments[0]);
      if (typeof key === "string") return { text: `state.${key}`, numbers: [] };
    }
  }
  if (ts.isPropertyAccessExpression(resolved)) {
    const base = renderOperand(resolved.expression, variables);
    if (base && /\)$/.test(base.text)) return { text: `${base.text}.${resolved.name.text}`, numbers: base.numbers };
  }
  const path = expandedMemberPath(resolved, variables);
  if (path && path.length >= 2) {
    const section = path.at(-2);
    const field = path.at(-1);
    if (section === "market" || section === "position" || section === "account") return { text: `${section}.${field}`, numbers: [] };
  }
  return undefined;
}

function renderCondition(node: ts.Expression, variables: Variables): Rendered | undefined {
  const resolved = resolve(node, variables);
  if (ts.isCallExpression(resolved)) {
    const path = memberPath(resolved.expression);
    const call = path?.at(-1);
    if (call === "crossedAbove" || call === "crossedBelow") {
      const args = resolved.arguments.map((argument) => renderOperand(argument, variables));
      if (args.length === 4 && args.every((argument) => argument !== undefined)) {
        const rendered = args as Rendered[];
        return {
          text: `${call === "crossedAbove" ? "crossAbove" : "crossBelow"}(${rendered.map((item) => item.text).join(",")})`,
          numbers: rendered.flatMap((item) => item.numbers),
        };
      }
    }
  }
  if (ts.isBinaryExpression(resolved)) {
    const operator = operatorText(resolved.operatorToken.kind);
    const left = renderOperand(resolved.left, variables);
    const right = renderOperand(resolved.right, variables);
    if (operator && left && right) {
      return { text: `${left.text} ${operator} ${right.text}`, numbers: [...left.numbers, ...right.numbers] };
    }
  }
  return undefined;
}

function flattenWithPositions(node: ts.Expression, variables: Variables): { known: ConditionNumbers[]; opaque: string[] } {
  const resolved = resolve(node, variables);
  if (ts.isBinaryExpression(resolved) && resolved.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const left = flattenWithPositions(resolved.left, variables);
    const right = flattenWithPositions(resolved.right, variables);
    return { known: [...left.known, ...right.known], opaque: [...left.opaque, ...right.opaque] };
  }
  if (isReadinessExpression(resolved, variables)) return { known: [], opaque: [] };
  const rendered = renderCondition(resolved, variables);
  return rendered
    ? { known: [{ canonical: rendered.text, numbers: rendered.numbers }], opaque: [] }
    : { known: [], opaque: [resolved.getText()] };
}

function decisionFromReturn(statement: ts.ReturnStatement): ContractDecision | undefined {
  if (!statement.expression || !ts.isObjectLiteralExpression(statement.expression)) return undefined;
  const type = literal(objectProperty(statement.expression, "type"));
  if (type !== "open" && type !== "close") return undefined;
  if (type === "close") {
    return { type, side: null, sizeKind: null, sizeValue: null, stopLossPercent: null, takeProfitRiskReward: null };
  }
  const size = objectProperty(statement.expression, "size");
  const side = literal(objectProperty(statement.expression, "side"));
  const sizeKind = size && ts.isObjectLiteralExpression(size) ? literal(objectProperty(size, "kind")) : undefined;
  const sizeValue = size && ts.isObjectLiteralExpression(size) ? numberProperty(size, "value") : null;
  if ((side !== "long" && side !== "short")
    || (sizeKind !== "riskPercent" && sizeKind !== "equityPercent" && sizeKind !== "fixedNotional")) return undefined;
  return {
    type,
    side,
    sizeKind,
    sizeValue,
    stopLossPercent: numberProperty(statement.expression, "stopLossPercent"),
    takeProfitRiskReward: numberProperty(statement.expression, "takeProfitRiskReward"),
  };
}

function numberProperty(object: ts.ObjectLiteralExpression, name: string): number | null {
  const value = literal(objectProperty(object, name));
  return typeof value === "number" ? value : null;
}

function collectVariables(node: ts.Node, variables: Variables): void {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    variables.set(node.name.text, node.initializer);
  }
  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
    for (const element of node.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const sourceName = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
        ? element.propertyName.text
        : element.name.text;
      variables.set(element.name.text, ts.factory.createPropertyAccessExpression(node.initializer, sourceName));
    }
  }
  ts.forEachChild(node, (child) => collectVariables(child, variables));
}

function findOnBarBody(sourceFile: ts.SourceFile): ts.Block | undefined {
  let body: ts.Block | undefined;
  const visit = (node: ts.Node): void => {
    if (body) return;
    if ((ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) && propertyName(node.name) === "onBar") {
      const candidate = ts.isMethodDeclaration(node) ? node.body : node.initializer;
      if (candidate && (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) && ts.isBlock(candidate.body)) body = candidate.body;
      if (candidate && ts.isBlock(candidate)) body = candidate;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return body;
}

function walkStatement(
  statement: ts.Statement,
  path: ConditionNumbers[],
  variables: Variables,
  branches: SourceBranch[],
): void {
  if (ts.isBlock(statement)) {
    for (const child of statement.statements) walkStatement(child, path, variables, branches);
    return;
  }
  if (ts.isIfStatement(statement)) {
    const conditions = flattenWithPositions(statement.expression, variables);
    walkStatement(statement.thenStatement, [...path, ...conditions.known], variables, branches);
    if (statement.elseStatement) walkStatement(statement.elseStatement, path, variables, branches);
    return;
  }
  if (ts.isReturnStatement(statement)) {
    const decision = decisionFromReturn(statement);
    if (decision) {
      branches.push({
        canonicalRule: canonicalRule({ when: path.map((condition) => condition.canonical), decision }),
        returnStatement: statement,
        conditions: path,
      });
    }
  }
}

function collectBranches(source: string): SourceBranch[] {
  const sourceFile = ts.createSourceFile("strategy.ts", source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const body = findOnBarBody(sourceFile);
  if (!body) throw new Error("Cannot locate strategy onBar body for parameter application.");
  const variables: Variables = new Map();
  collectVariables(body, variables);
  const branches: SourceBranch[] = [];
  for (const statement of body.statements) walkStatement(statement, [], variables, branches);
  return branches;
}

interface SourceEdit {
  position: number;
  length: number;
  text: string;
}

function numericSpan(node: ts.Expression | undefined): { position: number; length: number } | undefined {
  if (!node) return undefined;
  if (ts.isNumericLiteral(node)) return { position: node.getStart(), length: node.getEnd() - node.getStart() };
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return { position: node.operand.getStart(), length: node.operand.getEnd() - node.operand.getStart() };
  }
  return undefined;
}

function decisionFieldSpan(statement: ts.ReturnStatement, field: "sizeValue" | "stopLossPercent" | "takeProfitRiskReward"): { position: number; length: number } | undefined {
  if (!statement.expression || !ts.isObjectLiteralExpression(statement.expression)) return undefined;
  if (field === "sizeValue") {
    const size = objectProperty(statement.expression, "size");
    if (!size || !ts.isObjectLiteralExpression(size)) return undefined;
    return numericSpan(objectProperty(size, "value"));
  }
  return numericSpan(objectProperty(statement.expression, field));
}

type ResolvedNumberSource = { position: number; length: number; value: number };

function conditionNumbersSource(condition: ConditionNumbers, numberIndex: number): ResolvedNumberSource | undefined {
  const source = condition.numbers[numberIndex];
  if (!source || source.position === null) return undefined;
  return { position: source.position, length: source.length, value: source.value };
}

/**
 * Rewrites the program so every discovered parameter holds the requested value.
 * A parameter that cannot be located in the program throws — the strategy
 * cannot be safely optimized rather than silently corrupting the program.
 */
export function applyParametersToSource(
  source: string,
  contract: StrategyContract,
  definitions: ParameterDefinition[],
  values: Record<string, number>,
): string {
  const branches = collectBranches(source);
  const edits: SourceEdit[] = [];

  for (const [id, rawValue] of Object.entries(values)) {
    const definition = definitions.find((item) => item.id === id);
    if (!definition) throw new Error(`未知策略参数 ${id}`);
    const value = definition.kind === "integer" ? Math.round(rawValue) : rawValue;
    if (!Number.isFinite(value) || value < definition.hardMin || value > definition.hardMax) {
      throw new Error(`参数 ${definition.label} 超出安全范围`);
    }
    const rule = contract.rules[definition.target.ruleIndex];
    if (!rule) throw new Error(`参数 ${definition.label} 的规则已失效`);

    const contractRule = canonicalRule({
      when: rule.when.map(normalizeConditionNotation),
      decision: rule.decision,
    });
    const matching = branches.filter((branch) => branch.canonicalRule === contractRule);
    if (matching.length === 0) throw new Error(`无法在程序中定位参数 ${definition.label} 的规则`);

    for (const branch of matching) {
      if (definition.target.kind === "conditionNumber") {
        const canonical = normalizeConditionNotation(rule.when[definition.target.conditionIndex] ?? "");
        const condition = branch.conditions.find(
          (item) => compactCondition(item.canonical) === compactCondition(canonical),
        );
        if (!condition) throw new Error(`无法在程序中定位参数 ${definition.label} 的条件`);
        const number = conditionNumbersSource(condition, definition.target.numberIndex);
        if (!number) throw new Error(`参数 ${definition.label} 指向的数值在程序中没有字面量`);
        if (number.value === value) continue;
        edits.push({ position: number.position, length: number.length, text: String(value) });
      } else {
        const span = decisionFieldSpan(branch.returnStatement, definition.target.field);
        if (!span) throw new Error(`无法在程序中定位参数 ${definition.label}`);
        // The contract decision value equals the program literal (verify
        // guarantees consistency), so skipping an unchanged value avoids a
        // no-op rewrite.
        if (rule.decision[definition.target.field] === value) continue;
        edits.push({ position: span.position, length: span.length, text: String(value) });
      }
    }
  }

  if (edits.length === 0) return source;
  const sorted = [...edits].sort((left, right) => right.position - left.position);
  let result = source;
  for (const edit of sorted) {
    result = `${result.slice(0, edit.position)}${edit.text}${result.slice(edit.position + edit.length)}`;
  }
  return result;
}
