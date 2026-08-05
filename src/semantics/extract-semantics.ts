import ts from "typescript";

import type {
  ContractDecision,
  ContractRule,
  ContractValue,
  ExtractedStrategySemantics,
} from "./contract.js";
import { canonicalNumericExpression } from "./expression-ast.js";

type Variables = Map<string, ts.Expression>;

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

function indicatorCall(
  node: ts.CallExpression,
  variables: Variables,
): { name: string; interval?: string } | undefined {
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

function canonicalOperand(node: ts.Expression, variables: Variables): string | undefined {
  const resolved = resolve(node, variables);
  const value = literal(resolved);
  if (value !== undefined) return typeof value === "string" && value !== "true" && value !== "false" ? JSON.stringify(value) : String(value);
  if (ts.isCallExpression(resolved)) {
    const indicator = indicatorCall(resolved, variables);
    const path = memberPath(resolved.expression);
    if (indicator) {
      const { name, interval } = indicator;
      const args = resolved.arguments.map((argument) => canonicalOperand(argument, variables));
      if (args.every((argument) => argument !== undefined)) {
        let normalized = args;
        if (["sma", "ema", "highest", "lowest", "standardDeviation", "rsi"].includes(name)) {
          normalized = [args[0] ?? "", args[1] ?? "", args[2] ?? "0"];
        } else if (name === "atr") {
          normalized = [args[0] ?? "", args[1] ?? "0"];
        } else if (name === "macd") {
          normalized = [args[0] ?? '"close"', args[1] ?? "12", args[2] ?? "26", args[3] ?? "9", args[4] ?? "0"];
        } else if (name === "bollingerBands") {
          normalized = [args[0] ?? '"close"', args[1] ?? "20", args[2] ?? "2", args[3] ?? "0"];
        }
        const prefix = interval === undefined ? "" : `timeframe(${JSON.stringify(interval)}).`;
        return `${prefix}${name}(${normalized.join(",")})`;
      }
    }
    if (path?.at(-2) === "state" && path.at(-1) === "get") {
      const key = literal(resolved.arguments[0]);
      if (typeof key === "string") return `state.${key}`;
    }
  }
  if (ts.isPropertyAccessExpression(resolved)) {
    const base = canonicalOperand(resolved.expression, variables);
    if (base && /\)$/.test(base)) return `${base}.${resolved.name.text}`;
  }
  const path = expandedMemberPath(resolved, variables);
  if (path && path.length >= 2) {
    const section = path.at(-2);
    const field = path.at(-1);
    if (section === "market" || section === "position" || section === "account") return `${section}.${field}`;
  }
  return undefined;
}

/**
 * Canonicalizes a numeric operand, recursing through safe arithmetic.
 *
 * `canonicalOperand` only ever recognised leaves, so `market.close * 1.02` — an
 * operand shape the prompt explicitly offers the model — extracted as nothing
 * and the whole condition was recorded as opaque, which the verify gate treats
 * as grounds to refuse the strategy. Arithmetic is now folded in around the same
 * leaf canonicalizer.
 */
function canonicalExpression(node: ts.Expression, variables: Variables): string | undefined {
  return canonicalNumericExpression(node, variables, { resolve, leaf: canonicalOperand });
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

function canonicalCondition(node: ts.Expression, variables: Variables): string | undefined {
  const resolved = resolve(node, variables);
  if (ts.isCallExpression(resolved)) {
    const path = memberPath(resolved.expression);
    const call = path?.at(-1);
    if (call === "crossedAbove" || call === "crossedBelow") {
      const args = resolved.arguments.map((argument) => canonicalExpression(argument, variables));
      if (args.length === 4 && args.every((argument) => argument !== undefined)) {
        return `${call === "crossedAbove" ? "crossAbove" : "crossBelow"}(${args.join(",")})`;
      }
    }
  }
  if (ts.isBinaryExpression(resolved)) {
    const operator = operatorText(resolved.operatorToken.kind);
    const left = canonicalExpression(resolved.left, variables);
    const right = canonicalExpression(resolved.right, variables);
    if (operator && left !== undefined && right !== undefined) return `${left} ${operator} ${right}`;
  }
  return undefined;
}

function flattenConditions(node: ts.Expression, variables: Variables): { known: string[]; opaque: string[] } {
  const resolved = resolve(node, variables);
  if (ts.isBinaryExpression(resolved) && resolved.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const left = flattenConditions(resolved.left, variables);
    const right = flattenConditions(resolved.right, variables);
    return { known: [...left.known, ...right.known], opaque: [...left.opaque, ...right.opaque] };
  }
  if (isReadinessExpression(resolved, variables)) return { known: [], opaque: [] };
  const known = canonicalCondition(resolved, variables);
  return known
    ? { known: [known], opaque: [] }
    : { known: [], opaque: [resolved.getText()] };
}

function numberProperty(object: ts.ObjectLiteralExpression, name: string): number | null {
  const value = literal(objectProperty(object, name));
  return typeof value === "number" ? value : null;
}

/**
 * Reads a decision field that may compute its value, e.g. a stop sized from ATR.
 * A field the grammar cannot express stays null, which surfaces as a rule
 * mismatch rather than a silently dropped risk parameter.
 */
function valueProperty(object: ts.ObjectLiteralExpression, name: string, variables: Variables): ContractValue {
  const node = objectProperty(object, name);
  if (!node) return null;
  const value = literal(node);
  if (typeof value === "number") return value;
  return canonicalExpression(node, variables) ?? null;
}

function decisionFromReturn(statement: ts.ReturnStatement, variables: Variables): ContractDecision | undefined {
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
  if (
    (side !== "long" && side !== "short")
    || (sizeKind !== "riskPercent" && sizeKind !== "equityPercent" && sizeKind !== "fixedNotional")
  ) return undefined;
  return {
    type,
    side,
    sizeKind,
    sizeValue,
    stopLossPercent: valueProperty(statement.expression, "stopLossPercent", variables),
    takeProfitRiskReward: valueProperty(statement.expression, "takeProfitRiskReward", variables),
  };
}

function collectVariables(node: ts.Node, variables: Variables): void {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) variables.set(node.name.text, node.initializer);
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

function walkStatement(
  statement: ts.Statement,
  path: string[],
  opaquePath: string[],
  variables: Variables,
  rules: ContractRule[],
  opaqueConditions: string[],
): void {
  if (ts.isBlock(statement)) {
    for (const child of statement.statements) walkStatement(child, path, opaquePath, variables, rules, opaqueConditions);
    return;
  }
  if (ts.isIfStatement(statement)) {
    const conditions = flattenConditions(statement.expression, variables);
    walkStatement(statement.thenStatement, [...path, ...conditions.known], [...opaquePath, ...conditions.opaque], variables, rules, opaqueConditions);
    if (statement.elseStatement) walkStatement(statement.elseStatement, path, opaquePath, variables, rules, opaqueConditions);
    return;
  }
  if (ts.isReturnStatement(statement)) {
    const decision = decisionFromReturn(statement, variables);
    if (decision) {
      rules.push({ when: [...new Set(path)].sort(), decision });
      opaqueConditions.push(...opaquePath);
    }
  }
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

export function extractStrategySemantics(source: string): ExtractedStrategySemantics {
  const sourceFile = ts.createSourceFile("strategy.ts", source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const body = findOnBarBody(sourceFile);
  if (!body) throw new Error("Cannot locate strategy onBar body for semantic extraction.");
  const variables: Variables = new Map();
  collectVariables(body, variables);
  const rules: ContractRule[] = [];
  const opaqueConditions: string[] = [];
  for (const statement of body.statements) walkStatement(statement, [], [], variables, rules, opaqueConditions);
  return {
    rules: rules.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    opaqueConditions: [...new Set(opaqueConditions)].sort(),
  };
}
