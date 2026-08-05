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
 * This module is the pure half: parsing, evaluating and re-emitting canonical
 * expression text. The AST canonicalizer lives in `expression-ast.ts` so that
 * callers needing only evaluation do not pull in the TypeScript compiler.
 */

/** Indicator names that may appear as canonical operands. */
export const INDICATOR_NAMES = [
  "sma", "ema", "highest", "lowest", "percentChange",
  "standardDeviation", "rsi", "atr", "macd", "bollingerBands",
] as const;

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
export function splitBinary(value: string, operators: string): { left: string; operator: string; right: string } | undefined {
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

export function stripOuterParentheses(value: string): string {
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

const precedence = (operator: string): number => (operator === "+" || operator === "-" ? 1 : 2);

/**
 * Parenthesizes a nested operand only where precedence or associativity would
 * otherwise change its meaning, so two spellings of the same arithmetic reduce
 * to one canonical string. Without that, a contract saying `high-atr*2` and a
 * program computing `high-(atr*2)` compare as different rules.
 */
export function operandText(text: string, parentOperator: string, side: "left" | "right"): string {
  const value = stripOuterParentheses(text);
  const split = splitBinary(value, "+-") ?? splitBinary(value, "*/");
  if (!split) return value;
  const child = precedence(split.operator);
  const parent = precedence(parentOperator);
  if (child < parent) return `(${value})`;
  // Subtraction and division do not associate, so an equal-precedence operand on
  // their right has to keep its grouping.
  if (child === parent && side === "right" && (parentOperator === "-" || parentOperator === "/")) return `(${value})`;
  return value;
}

/**
 * Re-emits a canonical expression with redundant parentheses removed.
 *
 * Contract text arrives as the model wrote it, so the same arithmetic can reach
 * the comparison in a different but equivalent grouping than the one extracted
 * from the program. Both sides are put through this before they are compared.
 */
export function normalizeExpressionText(expression: string): string {
  const value = stripOuterParentheses(expression);
  if (value === "") return expression.trim();
  for (const operators of ["+-", "*/"]) {
    const split = splitBinary(value, operators);
    if (!split) continue;
    const left = normalizeExpressionText(split.left);
    const right = normalizeExpressionText(split.right);
    return `${operandText(left, split.operator, "left")}${split.operator}${operandText(right, split.operator, "right")}`;
  }
  if (value.startsWith("-")) return `-${operandText(normalizeExpressionText(value.slice(1)), "*", "right")}`;
  return value;
}


