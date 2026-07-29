import { compileStrategySource } from "../compiler/compile-strategy-source.js";
import type { SemanticDiagnostic, StrategyContract } from "./contract.js";
import { verifyStrategySemantics } from "./verify-semantics.js";

export interface StrategyMutation {
  id: string;
  description: string;
  source: string;
}

export interface MutationResult extends StrategyMutation {
  compiled: boolean;
  killed: boolean;
  diagnostics: SemanticDiagnostic[];
}

export interface MutationReport {
  total: number;
  compiled: number;
  killed: number;
  survived: number;
  killRate: number;
  results: MutationResult[];
}

function replaceOnce(source: string, pattern: RegExp, replacement: string | ((substring: string, ...args: string[]) => string)): string | undefined {
  if (!pattern.test(source)) return undefined;
  pattern.lastIndex = 0;
  return source.replace(pattern, replacement as string);
}

export function generateStrategyMutations(source: string): StrategyMutation[] {
  const mutations: Array<StrategyMutation | undefined> = [];
  const period = /((?:sma|ema|highest|lowest|rsi|atr)\(\s*["'](?:close|open|high|low|volume)["']\s*,\s*)(\d+)/;
  const periodMatch = period.exec(source);
  if (periodMatch?.[2]) {
    const changed = Number(periodMatch[2]) + 1;
    mutations.push({
      id: "indicator-period-plus-one",
      description: `Change the first indicator period from ${periodMatch[2]} to ${changed}.`,
      source: source.replace(period, `$1${changed}`),
    });
  }
  const cross = source.includes("crossedAbove")
    ? replaceOnce(source, /crossedAbove/, "crossedBelow")
    : replaceOnce(source, /crossedBelow/, "crossedAbove");
  if (cross) mutations.push({ id: "invert-cross-direction", description: "Invert the first crossover direction.", source: cross });
  const side = source.includes('side: "long"')
    ? replaceOnce(source, /side:\s*["']long["']/, 'side: "short"')
    : replaceOnce(source, /side:\s*["']short["']/, 'side: "long"');
  if (side) mutations.push({ id: "invert-position-side", description: "Invert the first open position side.", source: side });
  const risk = /((?:kind:\s*["']riskPercent["']\s*,\s*value:\s*))([0-9.]+)/;
  const riskMatch = risk.exec(source);
  if (riskMatch?.[2]) {
    const changed = Number(riskMatch[2]) * 10;
    mutations.push({ id: "risk-times-ten", description: "Multiply requested trade risk by ten.", source: source.replace(risk, `$1${changed}`) });
  }
  const stop = /(stopLossPercent:\s*)([0-9.]+)/;
  const stopMatch = stop.exec(source);
  if (stopMatch?.[2]) {
    const original = Number(stopMatch[2]);
    const changed = Math.min(0.99, original * 10);
    mutations.push({ id: "stop-times-ten", description: "Multiply stop-loss distance by ten.", source: source.replace(stop, `$1${changed}`) });
  }
  const close = replaceOnce(source, /return\s*\{\s*type:\s*["']close["']([^}]*)\}/, 'return { type: "hold" }');
  if (close) mutations.push({ id: "disable-close", description: "Replace the first close decision with hold.", source: close });
  return mutations.filter((mutation): mutation is StrategyMutation => mutation !== undefined && mutation.source !== source);
}

export async function evaluateStrategyMutations(source: string, contract: StrategyContract): Promise<MutationReport> {
  const results: MutationResult[] = [];
  for (const mutation of generateStrategyMutations(source)) {
    try {
      compileStrategySource(mutation.source);
      const verification = await verifyStrategySemantics(mutation.source, contract);
      results.push({ ...mutation, compiled: true, killed: !verification.ok, diagnostics: verification.diagnostics });
    } catch (error) {
      results.push({
        ...mutation,
        compiled: false,
        killed: true,
        diagnostics: [{ code: "MUTANT_COMPILE_FAILURE", message: error instanceof Error ? error.message : "Mutant did not compile." }],
      });
    }
  }
  const compiled = results.filter((result) => result.compiled).length;
  const killed = results.filter((result) => result.killed).length;
  return {
    total: results.length,
    compiled,
    killed,
    survived: results.length - killed,
    killRate: results.length > 0 ? killed / results.length : 1,
    results,
  };
}
