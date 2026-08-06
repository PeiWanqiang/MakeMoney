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

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  skipLibCheck: true,
};

/**
 * The compiler host is built once and keeps the files it has already parsed.
 *
 * `ts.createCompilerHost` reads and parses the whole default library from disk,
 * and that alone was about 75ms of the 80ms a compilation cost — paid again for
 * every program variant a parameter sweep produces. Every file except the
 * strategy under compilation is immutable input, so it is parsed once and
 * reused. The strategy file is still re-read and re-parsed on each call, and
 * each call still builds its own `ts.Program` and asks it for diagnostics from
 * scratch, so what a source is checked against has not changed.
 *
 * `pendingSource` is safe as shared state only because `compileStrategySource`
 * is synchronous: `createProgram` reads it back before any other caller can run.
 */
let sharedHost: ts.CompilerHost | null = null;
let pendingSource = "";

function compilerHost(): ts.CompilerHost {
  if (sharedHost) return sharedHost;
  const base = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const parsed = new Map<string, ts.SourceFile | undefined>();
  sharedHost = {
    ...base,
    fileExists: (fileName) => fileName === GENERATED_FILE || fileName === SDK_FILE || base.fileExists(fileName),
    readFile: (fileName) => {
      if (fileName === GENERATED_FILE) return pendingSource;
      if (fileName === SDK_FILE) return STRATEGY_SDK_DECLARATION;
      return base.readFile(fileName);
    },
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      if (fileName === GENERATED_FILE) return ts.createSourceFile(fileName, pendingSource, languageVersion, true);
      const target = typeof languageVersion === "object" ? languageVersion.languageVersion : languageVersion;
      const key = `${fileName}:${target}`;
      if (!parsed.has(key)) {
        parsed.set(key, fileName === SDK_FILE
          ? ts.createSourceFile(fileName, STRATEGY_SDK_DECLARATION, languageVersion, true)
          : base.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile));
      }
      return parsed.get(key);
    },
  };
  return sharedHost;
}

function typeScriptDiagnostics(source: string): SourceDiagnostic[] {
  pendingSource = source;
  const program = ts.createProgram([GENERATED_FILE, SDK_FILE], COMPILER_OPTIONS, compilerHost());
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

/**
 * Compilation is a pure function of the source text, and `typeScriptDiagnostics`
 * builds a whole TypeScript program — including reading the real lib files from
 * disk — which measures around 80ms per call. A parameter sweep re-compiles the
 * same handful of program variants dozens of times (every `runBacktest` compiles
 * afresh), so the results are memoized on the source text.
 *
 * Only successful compilations are cached: a rejected source aborts whatever
 * asked for it, so there is no hot path to protect, and reusing one error
 * instance would hand every caller the same stale stack.
 */
const compilationCache = new Map<string, CompiledStrategyProgram>();
const COMPILATION_CACHE_LIMIT = 256;

export function compileStrategySource(source: string): CompiledStrategyProgram {
  const cached = compilationCache.get(source);
  if (cached) {
    // Re-insert so the eviction below drops the least recently used entry.
    compilationCache.delete(source);
    compilationCache.set(source, cached);
    return cached;
  }

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
  // The instance is shared by every caller from here on, so it is frozen rather
  // than trusting each of them to treat it as read-only.
  const program: CompiledStrategyProgram = Object.freeze({ source, javascript, sourceHash });
  compilationCache.set(source, program);
  if (compilationCache.size > COMPILATION_CACHE_LIMIT) {
    const oldest = compilationCache.keys().next();
    if (!oldest.done) compilationCache.delete(oldest.value);
  }
  return program;
}
