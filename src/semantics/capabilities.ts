import ts from "typescript";

/**
 * The capabilities a strategy program can draw on. The verify gate compares what
 * a program actually uses against what the caller's data pipeline can feed the
 * engine. Data fields beyond plain OHLCV are the critical ones: a caller that
 * only transports klines cannot honor a `market.fundingRate` gate, and it is far
 * better to learn that at analyze time than to fail the backtest.
 */
export type StrategyCapability =
  | "ohlcv"
  | "turnover"
  | "markPrice"
  | "fundingRate"
  | "openInterest"
  | "multiTimeframe"
  | "state"
  | "indicators"
  | "arithmetic";

const FIELD_CAPABILITY: Record<string, StrategyCapability> = {
  open: "ohlcv",
  high: "ohlcv",
  low: "ohlcv",
  close: "ohlcv",
  volume: "ohlcv",
  quoteVolume: "turnover",
  takerBuyBaseVolume: "turnover",
  takerBuyQuoteVolume: "turnover",
  markPrice: "markPrice",
  fundingRate: "fundingRate",
  openInterest: "openInterest",
};

/** Indicator methods whose first argument names the field the window runs over. */
const FIELD_ARG_INDICATORS = new Set([
  "sma",
  "ema",
  "highest",
  "lowest",
  "standardDeviation",
  "rsi",
  "percentChange",
  "macd",
  "bollingerBands",
]);

const ARITHMETIC_OPERATORS = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
]);

type Variables = Map<string, ts.Expression>;

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
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

/**
 * Resolves an expression to its member-access path, following local variable
 * indirection (`const sma = ctx.indicators.sma(...)` then `sma` reads it) and
 * timeframe views (`const hour = ctx.timeframe("1h")` then `hour.indicators`).
 */
function expandedPath(node: ts.Expression, variables: Variables, seen = new Set<string>()): string[] | undefined {
  if (ts.isIdentifier(node)) {
    const replacement = variables.get(node.text);
    if (replacement && !seen.has(node.text)) {
      seen.add(node.text);
      const via = expandedPath(replacement, variables, seen);
      if (via) return via;
    }
    return [node.text];
  }
  if (ts.isPropertyAccessExpression(node)) {
    const parent = expandedPath(node.expression, variables, seen);
    return parent ? [...parent, node.name.text] : undefined;
  }
  if (ts.isCallExpression(node)) {
    return expandedPath(node.expression, variables, seen);
  }
  return undefined;
}

function stringLiteral(node: ts.Expression | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function bindingElementName(element: ts.BindingElement): string | undefined {
  const fieldName = element.propertyName
    ? (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName) ? element.propertyName.text : undefined)
    : (ts.isIdentifier(element.name) ? element.name.text : undefined);
  return fieldName ?? undefined;
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

/**
 * Scans the strategy program and returns the capabilities its onBar logic uses.
 * Conservative by design: when a field reference cannot be resolved it is not
 * claimed as a capability, but the common generated patterns (direct field
 * reads, indicator/history field arguments, destructured `market`) are covered.
 */
export function usedCapabilities(source: string): Set<StrategyCapability> {
  const sourceFile = ts.createSourceFile("strategy.ts", source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const used = new Set<StrategyCapability>();
  const body = findOnBarBody(sourceFile);
  if (!body) return used;

  const variables: Variables = new Map();
  collectVariables(body, variables);

  const scan = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const path = expandedPath(node.expression, variables);
      const method = path?.at(-1);
      const receiver = path?.at(-2);
      if (method === "timeframe") {
        used.add("multiTimeframe");
      } else if (receiver === "history" && (method === "values" || method === "bars")) {
        const field = stringLiteral(node.arguments[0]);
        if (field && FIELD_CAPABILITY[field]) used.add(FIELD_CAPABILITY[field]!);
      } else if (receiver === "indicators" && method && FIELD_ARG_INDICATORS.has(method)) {
        const field = stringLiteral(node.arguments[0]);
        if (field && FIELD_CAPABILITY[field]) used.add(FIELD_CAPABILITY[field]!);
      } else if (receiver === "state" && (method === "get" || method === "set")) {
        used.add("state");
      } else if (path?.includes("state")) {
        used.add("state");
      }
      node.arguments.forEach(scan);
    } else if (ts.isPropertyAccessExpression(node)) {
      const path = expandedPath(node, variables);
      if (path) {
        const receiver = path.at(-2);
        const field = path.at(-1);
        if (receiver === "market" && field && FIELD_CAPABILITY[field]) used.add(FIELD_CAPABILITY[field]!);
        if (receiver === "indicators") used.add("indicators");
        if (receiver === "state") used.add("state");
        if (path.includes("timeframe")) used.add("multiTimeframe");
      }
      scan(node.expression);
    } else if (ts.isBinaryExpression(node)) {
      if (ARITHMETIC_OPERATORS.has(node.operatorToken.kind)) used.add("arithmetic");
      scan(node.left);
      scan(node.right);
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const path = expandedPath(node.initializer, variables);
      if (path?.at(-1) === "market") {
        for (const element of node.name.elements) {
          const field = bindingElementName(element);
          if (field && FIELD_CAPABILITY[field]) used.add(FIELD_CAPABILITY[field]!);
        }
      }
      scan(node.initializer);
    }
    ts.forEachChild(node, scan);
  };

  scan(body);
  return used;
}
