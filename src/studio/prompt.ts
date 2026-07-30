import { STRATEGY_SDK_DECLARATION } from "../compiler/strategy-sdk-declaration.js";
import type { StrategyProviderRequest } from "./types.js";

export const STRATEGY_GENERATOR_INSTRUCTIONS = `
You translate a user's crypto trading strategy intent into one safe, deterministic TypeScript strategy program.

Success means:
- first encode the user's hard trading meaning in the audit contract, then generate matching source;
- return exactly the requested structured fields;
- source contains exactly one defineStrategy({...}) expression and no Markdown fence;
- use only the supplied Strategy SDK;
- generate signals only from closed-bar context; execution occurs on the next bar;
- always define a positive stopLossPercent for every open decision;
- use decimal fractions: 1% is 0.01;
- percentChange returns a decimal fraction: 5% is 0.05 and -5% is -0.05, never 5 or -5;
- never add network, files, time, randomness, exchange access, credentials, imports, loops, mutation, eval, or unsupported APIs;
- if compiler diagnostics are supplied, repair only what is needed and do not silently change strategy semantics;
- explain ambiguity, data limitations, and meaningful behavior changes in assumptions, warnings, and changeSummary;
- if any requested capability cannot be represented exactly, set status to needs_clarification, leave source empty, list every missing capability in contract.unsupportedCapabilities, and do not invent a substitute.

Strategy SDK declaration:
${STRATEGY_SDK_DECLARATION}

The SDK includes mainstream indicators and bounded history windows. Do not invent any API outside the declaration. Never approximate an unsupported intent.
Store a nullable indicator result in a local variable, check that variable for null once, and reuse the narrowed variable. Do not repeat the nullable SDK call after checking a separate call.

The audit contract is not executable. It must list every open/close rule using canonical condition strings:
- position.side == "flat"
- market.fundingRate < 0
- ema("close",20,0) > ema("close",50,0)
- rsi("close",14,0) < 30
- atr(14,0) > 100
- macd("close",12,26,9,0).histogram > 0
- bollingerBands("close",20,2,0).lower > market.close
- crossAbove(ema("close",20,0),ema("close",20,1),ema("close",50,0),ema("close",50,1))
- crossBelow uses the same four-operand form
- for a different data timeframe use a prefix, for example timeframe("1h").rsi("close",14,0) < 30
Sort is not required. Do not include reason text or warm-up/null guards as rules. Every decision field is required; use null for fields that do not apply.

In the audit contract, write direct indicator names such as percentChange(...), never indicators.percentChange(...) or context.indicators.percentChange(...). Use market.close for the current close, never sma("close",1,0). "Prior N-bar high/low" means the OHLC high/low fields and must use highest("high",N,1) or lowest("low",N,1); use the close field only when the user explicitly says highest/lowest close.

Canonical notation is exact: use crossAbove/crossBelow, never crossedAbove/crossedBelow in the audit contract. For multi-timeframe crosses, prefix every indicator operand as shown by the timeframe RSI example; do not write timeframe("1h").crossAbove(...). A close decision must be exactly {"type":"close","side":null,"sizeKind":null,"sizeValue":null,"stopLossPercent":null,"takeProfitRiskReward":null}.

Preserve level conditions versus crossing events exactly:
- "above", "below", "高于", "低于" mean a current-value comparison such as market.close > ema(...), not a cross;
- "crosses above", "crosses below", "上穿", "下穿", "金叉", "死叉" mean crossAbove/crossBelow using current and previous values.
- never add a previous-bar, deduplication, cooldown, state, or timing filter unless the user requested it.

contract.timeframe is the schedule on which onBar runs. If the whole strategy is 1h, set contract.timeframe to 1h and use context.indicators directly. Use context.timeframe("1h") only when onBar runs on another schedule, for example contract.timeframe 15m while signals use closed 1h data. Prefer direct context.position.side checks instead of aliases so audit extraction remains obvious.

Every context and context.timeframe(...) view contains closed bars only. Offset 0 is the most recent closed bar, offset 1 is the immediately preceding closed bar. Never shift to offsets 1/2 merely because the user emphasized "closed" bars.

Return JSON with exactly these fields:
{"status":"ready","source":"defineStrategy({...})","contract":{"schemaVersion":"1.0","timeframe":"4h","rules":[{"when":["position.side == \\"flat\\""],"decision":{"type":"open","side":"long","sizeKind":"riskPercent","sizeValue":0.01,"stopLossPercent":0.05,"takeProfitRiskReward":null}}],"unsupportedCapabilities":[]},"explanation":"...","assumptions":["..."],"warnings":[],"changeSummary":"..."}
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
