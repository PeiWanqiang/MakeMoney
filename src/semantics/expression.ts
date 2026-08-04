/**
 * The numeric expression grammar shared by contract conditions and contract
 * decision fields.
 *
 * The audit contract quantifies what a strategy does so a machine can check the
 * generated program against it. That check is only as expressive as this
 * grammar: an operand it cannot canonicalize becomes an opaque condition and the
 * verify gate refuses the strategy. Arithmetic was advertised to the model as a
 * supported capability long before anything could extract it, so every strategy
 * that used it was rejected — and the same gap is why a stop loss could only be
 * a literal, since a stop computed from ATR is just an operand this grammar had
 * no way to express.
 *
 * Canonicalization and evaluation live together because they must agree: a
 * string produced by `canonicalNumericExpression` has to be readable by
 * `evaluateNumericExpression`, and a scenario is only meaningful if the value the
 * verifier computes is the value the sandbox computed.
 */
import ts from "typescript";

/** Indicator names that may appear as canonical operands. */
export const INDICATOR_NAMES = [
  "sma", "ema", "highest", "lowest", "percentChange",
  "standardDeviation", "rsi", "atr", "macd", "bollingerBands",
] as const;

/** Composite indicator members reachable with a trailing property access. */
const INDICATOR_MEMBERS = new Set(["macd", "signal", "histogram", "middle", "upper", "lower"]);

const INDICATOR_PATTERN = new RegExp(
  `^(?:timeframe\\("(?:1m|15m|1h|4h)"\\)\\.)?(?:${INDICATOR_NAMES.join("|")})\\(`,
);

/** Values a canonical expression can read while being evaluated. */
export interface ExpressionEnvironment {
  /** Keyed by the canonical operand text, e.g. `atr(14,0)` or `macd("close",12,26,9,0).signal`. */
  indicators?: Record<string, number | undefined>;
  /** Keyed by field name, e.g. `close`. */
  market?: Record<string, number | undefined>;
  /** Keyed by field name, e.g. `equity`. */
  account?: Record<string, number | undefined>;
  /** Keyed by state key. */
  state?: Record<string, number | undefined>;
}

export function isIndicatorOperand(value: string): boolean {
  return INDICATOR_PATTERN.test(value);
}

/**
 * Splits on the lowest-precedence top-level operator, scanning right to left so
 * equal-precedence operators associate left as JavaScript does.
 *
 * A `+` or `-` directly after another operator or an opening parenthesis is a
 * sign, not a binary operator, and must not split.
 */
function splitBinary(value: string, operators: string): { left: string; operator: string; right: string } | undefined {
  let depth = 0;
  let quoted = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const character = value[index]!;
    if (character === '"' && value[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === ")") depth += 1;
    else if (character === "(") depth -= 1;
    if (depth !== 0 || !operators.includes(character)) continue;
    const previous = value[index - 1];
    if ((character === "+" || character === "-") && (previous === undefined || "+-*/(,".includes(previous))) continue;
    if (index === 0) continue;
    return { left: value.slice(0, index), operator: character, right: value.slice(index + 1) };
  }
  return undefined;
}

function stripOuterParentheses(value: string): string {
  let output = value.trim();
  while (output.startsWith("(") && output.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let index = 0; index < output.length; index += 1) {
      if (output[index] === "(") depth += 1;
      else if (output[index] === ")") depth -= 1;
      if (depth === 0 && index < output.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    output = output.slice(1, -1).trim();
  }
  return output;
}

/**
 * Evaluates a canonical expression against an environment.
 *
 * Returns undefined rather than throwing when the expression reads something the
 * environment does not define, so a caller can treat "cannot evaluate" as a
 * distinct outcome from "evaluated to a number".
 */
export function evaluateNumericExpression(expression: string, environment: ExpressionEnvironment): number | undefined {
  const value = stripOuterParentheses(expression);
  if (value === "") return undefined;

  for (const operators of ["+-", "*/"]) {
    const split = splitBinary(value, operators);
    if (!split) continue;
    const left = evaluateNumericExpression(split.left, environment);
    const right = evaluateNumericExpression(split.right, environment);
    if (left === undefined || right === undefined) return undefined;
    if (split.operator === "+") return left + right;
    if (split.operator === "-") return left - right;
    if (split.operator === "*") return left * right;
    return right === 0 ? undefined : left / right;
  }

  if (value.startsWith("-")) {
    const operand = evaluateNumericExpression(value.slice(1), environment);
    return operand === undefined ? undefined : -operand;
  }
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
  if (isIndicatorOperand(value)) return environment.indicators?.[value];

  const separator = value.lastIndexOf(".");
  if (separator > 0) {
    const section = value.slice(0, separator);
    const field = value.slice(separator + 1);
    if (section === "market") return environment.market?.[field];
    if (section === "account") return environment.account?.[field];
    if (section === "state") return environment.state?.[field];
  }
  return undefined;
}

/** Every distinct operand a canonical expression reads, for environment seeding. */
export function expressionOperands(expression: string): string[] {
  const operands = new Set<string>();
  const walk = (input: string): void => {
    const value = stripOuterParentheses(input);
    if (value === "") return;
    for (const operators of ["+-", "*/"]) {
      const split = splitBinary(value, operators);
      if (!split) continue;
      walk(split.left);
      walk(split.right);
      return;
    }
    if (value.startsWith("-")) {
      walk(value.slice(1));
      return;
    }
    if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return;
    operands.add(value);
  };
  walk(expression);
  return [...operands];
}

/** True when the expression is more than a single operand, i.e. it computes something. */
export function isCompositeExpression(expression: string): boolean {
  const value = stripOuterParentheses(expression);
  return splitBinary(value, "+-") !== undefined || splitBinary(value, "*/") !== undefined;
}

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

/** Parenthesizes a nested operand only where precedence would otherwise change. */
function operandText(text: string, parentOperator: string, side: "left" | "right"): string {
  if (!isCompositeExpression(text)) return text;
  const split = splitBinary(stripOuterParentheses(text), "+-") ?? splitBinary(stripOuterParentheses(text), "*/");
  const childOperator = split?.operator ?? "";
  const additive = (operator: string): boolean => operator === "+" || operator === "-";
  if (additive(childOperator) && !additive(parentOperator)) return `(${text})`;
  if (side === "right" && (parentOperator === "-" || parentOperator === "/")) return `(${text})`;
  if (additive(parentOperator) && additive(childOperator) && side === "right") return `(${text})`;
  return text;
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
