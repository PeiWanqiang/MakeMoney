import { parse } from "@typescript-eslint/typescript-estree";

interface AstNode {
  type: string;
  loc?: {
    start: { line: number; column: number };
  } | null;
  [key: string]: unknown;
}

export interface SourceDiagnostic {
  code: string;
  message: string;
  line?: number;
  column?: number;
}

export interface SourceValidationResult {
  ok: boolean;
  diagnostics: SourceDiagnostic[];
}

const FORBIDDEN_NODE_TYPES = new Map<string, string>([
  ["ImportDeclaration", "Imports are not available inside a strategy program."],
  ["ImportExpression", "Dynamic imports are not available inside a strategy program."],
  ["ExportNamedDeclaration", "A strategy must be a single defineStrategy(...) expression."],
  ["ExportDefaultDeclaration", "A strategy must be a single defineStrategy(...) expression."],
  ["AwaitExpression", "Async operations are not deterministic and are not allowed."],
  ["NewExpression", "Object construction with new is not allowed."],
  ["WhileStatement", "Unbounded loops are not allowed."],
  ["DoWhileStatement", "Unbounded loops are not allowed."],
  ["ForStatement", "Loops are not allowed in the first strategy-program version."],
  ["ForInStatement", "Loops are not allowed in the first strategy-program version."],
  ["ForOfStatement", "Loops are not allowed in the first strategy-program version."],
  ["WithStatement", "with is not allowed."],
  ["DebuggerStatement", "debugger is not allowed."],
  ["AssignmentExpression", "Mutation is not allowed; use context.state.set for persistent state."],
  ["UpdateExpression", "Mutation is not allowed; use immutable local calculations."],
]);

const FORBIDDEN_IDENTIFIERS = new Set([
  "process",
  "require",
  "module",
  "exports",
  "global",
  "globalThis",
  "window",
  "document",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "Date",
  "performance",
  "crypto",
  "eval",
  "Function",
  "WebAssembly",
  "Atomics",
  "SharedArrayBuffer",
]);

const FORBIDDEN_PROPERTIES = new Set(["constructor", "prototype", "__proto__"]);

function diagnostic(node: AstNode, code: string, message: string): SourceDiagnostic {
  const start = node.loc?.start;
  return {
    code,
    message,
    ...(start ? { line: start.line, column: start.column + 1 } : {}),
  };
}

function isNode(value: unknown): value is AstNode {
  return value !== null && typeof value === "object" && "type" in value && typeof (value as AstNode).type === "string";
}

function walk(node: AstNode, diagnostics: SourceDiagnostic[], parentKey?: string): void {
  const forbiddenMessage = FORBIDDEN_NODE_TYPES.get(node.type);
  if (forbiddenMessage) {
    diagnostics.push(diagnostic(node, "FORBIDDEN_SYNTAX", forbiddenMessage));
  }

  if (node.type === "Identifier") {
    const name = node.name;
    if (typeof name === "string") {
      const isStaticPropertyKey = parentKey === "key";
      if (!isStaticPropertyKey && (FORBIDDEN_IDENTIFIERS.has(name) || name.startsWith("__"))) {
        diagnostics.push(diagnostic(node, "FORBIDDEN_IDENTIFIER", `Identifier '${name}' is not available in strategy programs.`));
      }
    }
  }

  if (node.type === "MemberExpression") {
    const property = node.property;
    if (isNode(property)) {
      const propertyName = property.type === "Identifier" ? property.name : property.type === "Literal" ? property.value : undefined;
      if (typeof propertyName === "string" && FORBIDDEN_PROPERTIES.has(propertyName)) {
        diagnostics.push(diagnostic(node, "FORBIDDEN_PROPERTY", `Property '${propertyName}' is not accessible.`));
      }
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "range" || key === "tokens" || key === "comments") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) {
          walk(item, diagnostics, key);
        }
      }
    } else if (isNode(value)) {
      walk(value, diagnostics, key);
    }
  }
}

function validateProgramShape(program: AstNode, diagnostics: SourceDiagnostic[]): void {
  const body = program.body;
  if (!Array.isArray(body) || body.length !== 1 || !isNode(body[0]) || body[0].type !== "ExpressionStatement") {
    diagnostics.push({
      code: "INVALID_PROGRAM_SHAPE",
      message: "A strategy program must contain exactly one defineStrategy({...}) expression.",
    });
    return;
  }

  const expression = body[0].expression;
  if (!isNode(expression) || expression.type !== "CallExpression") {
    diagnostics.push(diagnostic(body[0], "INVALID_PROGRAM_SHAPE", "The top-level expression must call defineStrategy."));
    return;
  }

  const callee = expression.callee;
  if (!isNode(callee) || callee.type !== "Identifier" || callee.name !== "defineStrategy") {
    diagnostics.push(diagnostic(expression, "INVALID_PROGRAM_SHAPE", "The top-level expression must call defineStrategy."));
  }

  const args = expression.arguments;
  if (!Array.isArray(args) || args.length !== 1 || !isNode(args[0]) || args[0].type !== "ObjectExpression") {
    diagnostics.push(diagnostic(expression, "INVALID_DEFINITION", "defineStrategy must receive one object literal."));
    return;
  }

  const properties = args[0].properties;
  if (!Array.isArray(properties)) {
    diagnostics.push(diagnostic(args[0], "INVALID_DEFINITION", "Strategy definition is missing properties."));
    return;
  }

  const propertyNames = new Set<string>();
  for (const property of properties) {
    if (!isNode(property) || property.type !== "Property") {
      continue;
    }
    const key = property.key;
    if (isNode(key)) {
      if (key.type === "Identifier" && typeof key.name === "string") {
        propertyNames.add(key.name);
      } else if (key.type === "Literal" && typeof key.value === "string") {
        propertyNames.add(key.value);
      }
    }
  }

  for (const required of ["id", "name", "version", "onBar"]) {
    if (!propertyNames.has(required)) {
      diagnostics.push(diagnostic(args[0], "MISSING_DEFINITION_FIELD", `Strategy definition requires '${required}'.`));
    }
  }
}

export function validateStrategySource(source: string): SourceValidationResult {
  const diagnostics: SourceDiagnostic[] = [];
  let program: AstNode;

  try {
    program = parse(source, {
      loc: true,
      range: true,
      jsx: false,
      filePath: "generated.strategy.ts",
    }) as unknown as AstNode;
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "PARSE_ERROR",
          message: error instanceof Error ? error.message : "Unable to parse strategy source.",
        },
      ],
    };
  }

  validateProgramShape(program, diagnostics);
  walk(program, diagnostics);

  return { ok: diagnostics.length === 0, diagnostics };
}
