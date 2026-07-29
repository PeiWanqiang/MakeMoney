import { createHash } from "node:crypto";

import ts from "typescript";

import { STRATEGY_SDK_DECLARATION } from "./strategy-sdk-declaration.js";
import { validateStrategySource, type SourceDiagnostic } from "./validate-strategy-source.js";

export interface CompiledStrategyProgram {
  source: string;
  javascript: string;
  sourceHash: string;
}

export type StrategyCompilationPhase = "source-validation" | "typescript";

export class StrategyCompilationError extends Error {
  readonly phase: StrategyCompilationPhase;
  readonly diagnostics: SourceDiagnostic[];

  constructor(phase: StrategyCompilationPhase, diagnostics: SourceDiagnostic[]) {
    super(diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    this.name = "StrategyCompilationError";
    this.phase = phase;
    this.diagnostics = diagnostics;
  }
}

const GENERATED_FILE = "/generated.strategy.ts";
const SDK_FILE = "/strategy-sdk.d.ts";

function typeScriptDiagnostics(source: string): SourceDiagnostic[] {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options, true);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const virtualFiles = new Map([
    [GENERATED_FILE, source],
    [SDK_FILE, STRATEGY_SDK_DECLARATION],
  ]);

  host.fileExists = (fileName) => virtualFiles.has(fileName) || originalFileExists(fileName);
  host.readFile = (fileName) => virtualFiles.get(fileName) ?? originalReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = virtualFiles.get(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };

  const program = ts.createProgram([GENERATED_FILE, SDK_FILE], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((item) => item.file?.fileName === GENERATED_FILE)
    .map((item) => {
      const position = item.file && item.start !== undefined
        ? item.file.getLineAndCharacterOfPosition(item.start)
        : undefined;
      return {
        code: `TS${item.code}`,
        message: ts.flattenDiagnosticMessageText(item.messageText, "\n"),
        ...(position ? { line: position.line + 1, column: position.character + 1 } : {}),
      };
    });
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
    throw new StrategyCompilationError("source-validation", validation.diagnostics);
  }

  const semanticDiagnostics = typeScriptDiagnostics(source);
  if (semanticDiagnostics.length > 0) {
    throw new StrategyCompilationError("typescript", semanticDiagnostics);
  }

  const javascript = transpile(source);
  const sourceHash = createHash("sha256").update(javascript).digest("hex");
  return { source, javascript, sourceHash };
}
