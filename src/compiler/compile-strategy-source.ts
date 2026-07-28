import { createHash } from "node:crypto";

import ts from "typescript";

import { validateStrategySource } from "./validate-strategy-source.js";

export interface CompiledStrategyProgram {
  source: string;
  javascript: string;
  sourceHash: string;
}

function transpile(source: string): string {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ES2020,
      strict: true,
      removeComments: false,
    },
    reportDiagnostics: true,
    fileName: "generated.strategy.ts",
  });

  const errors = output.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length > 0) {
    throw new Error(errors.map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n")).join("\n"));
  }

  return output.outputText
    .trim()
    .replace(/^(["'])use strict\1;\s*/, "")
    .replace(/;$/, "")
    .replaceAll("\r\n", "\n");
}

export function compileStrategySource(source: string): CompiledStrategyProgram {
  const validation = validateStrategySource(source);
  if (!validation.ok) {
    throw new Error(validation.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
  }

  const javascript = transpile(source);
  const sourceHash = createHash("sha256").update(javascript).digest("hex");
  return { source, javascript, sourceHash };
}

