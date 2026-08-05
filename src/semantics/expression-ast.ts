/**
 * Canonicalizes a numeric expression out of the program AST.
 *
 * Split from `expression.ts` so that evaluating canonical text — which the web
 * worker and the scenario runner both do — never drags the TypeScript compiler
 * along. The two halves must agree: a string produced here has to be readable by
 * `evaluateNumericExpression`, since a scenario is only meaningful when the value
 * the verifier computes is the value the sandbox computed.
 */
import ts from "typescript";

import { operandText } from "./expression.js";

type Variables = Map<string, ts.Expression>;

export interface CanonicalContext {
  /** Resolves an identifier to the expression it was assigned, following aliases. */
  resolve: (node: ts.Expression, variables: Variables) => ts.Expression;
  /** Canonicalizes a leaf operand: literal, indicator call, market path, state read. */
  leaf: (node: ts.Expression, variables: Variables) => string | undefined;
}

function binaryOperatorText(kind: ts.SyntaxKind): string | undefined {
  if (kind === ts.SyntaxKind.PlusToken) return "+";
  if (kind === ts.SyntaxKind.MinusToken) return "-";
  if (kind === ts.SyntaxKind.AsteriskToken) return "*";
  if (kind === ts.SyntaxKind.SlashToken) return "/";
  return undefined;
}

/**
 * Canonicalizes a numeric expression from the program AST, recursing through
 * safe arithmetic and delegating leaves to the caller's operand canonicalizer.
 */
export function canonicalNumericExpression(
  node: ts.Expression,
  variables: Variables,
  context: CanonicalContext,
): string | undefined {
  const resolved = context.resolve(node, variables);
  if (ts.isParenthesizedExpression(resolved)) {
    return canonicalNumericExpression(resolved.expression, variables, context);
  }
  // A leaf is tried first: a negative numeric literal is one operand, not a
  // negation of a positive one, and indicator calls carry their own parentheses.
  const leaf = context.leaf(resolved, variables);
  if (leaf !== undefined) return leaf;
  if (ts.isPrefixUnaryExpression(resolved) && resolved.operator === ts.SyntaxKind.MinusToken) {
    const operand = canonicalNumericExpression(resolved.operand, variables, context);
    return operand === undefined ? undefined : `-${operandText(operand, "*", "right")}`;
  }
  if (!ts.isBinaryExpression(resolved)) return undefined;
  const operator = binaryOperatorText(resolved.operatorToken.kind);
  if (!operator) return undefined;
  const left = canonicalNumericExpression(resolved.left, variables, context);
  const right = canonicalNumericExpression(resolved.right, variables, context);
  if (left === undefined || right === undefined) return undefined;
  return `${operandText(left, operator, "left")}${operator}${operandText(right, operator, "right")}`;
}
