import { STRATEGY_SDK_DECLARATION } from "../compiler/strategy-sdk-declaration.js";
import type { StrategyProviderRequest } from "./types.js";

export const STRATEGY_GENERATOR_INSTRUCTIONS = `
You translate a user's crypto trading strategy intent into one safe, deterministic TypeScript strategy program.

Success means:
- preserve the user's trading meaning and explicitly list necessary assumptions;
- return exactly the requested structured fields;
- source contains exactly one defineStrategy({...}) expression and no Markdown fence;
- use only the supplied Strategy SDK;
- generate signals only from closed-bar context; execution occurs on the next bar;
- always define a positive stopLossPercent for every open decision;
- use decimal fractions: 1% is 0.01;
- never add network, files, time, randomness, exchange access, credentials, imports, loops, mutation, eval, or unsupported APIs;
- if compiler diagnostics are supplied, repair only what is needed and do not silently change strategy semantics;
- explain ambiguity, data limitations, and meaningful behavior changes in assumptions, warnings, and changeSummary.

Strategy SDK declaration:
${STRATEGY_SDK_DECLARATION}

The available indicators are deliberately small. Express a strategy using only these capabilities; do not invent RSI, MACD, ATR, order-book, liquidation, or other APIs. If the intent cannot be represented faithfully, produce the closest safe program and state the limitation as a warning.

Return JSON with exactly these fields:
{"source":"defineStrategy({...})","explanation":"...","assumptions":["..."],"warnings":["..."],"changeSummary":"..."}
`.trim();

function diagnosticsText(request: StrategyProviderRequest): string {
  if (!request.compilerDiagnostics || request.compilerDiagnostics.length === 0) return "None.";
  return request.compilerDiagnostics
    .map((item) => `${item.code}${item.line ? ` at ${item.line}:${item.column ?? 1}` : ""}: ${item.message}`)
    .join("\n");
}

export function buildStrategyProviderInput(request: StrategyProviderRequest): string {
  return `
Mode: ${request.mode}
Original strategy intent: ${request.originalIntent}
Current user request: ${request.userIntent}
Attempt: ${request.attempt}

Current candidate/source:
${request.currentSource ?? "None. Create the initial program."}

Compiler diagnostics:
${diagnosticsText(request)}

Return a complete program, even for a revision or repair. The id must remain stable across revisions and version must increase for a user-requested revision. Compiler-only repairs must preserve id, version, thresholds, direction, sizing, exits, and risk unless a diagnostic makes that exact text impossible.
  `.trim();
}
