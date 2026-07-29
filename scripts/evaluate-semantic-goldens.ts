import { GOLDEN_INTENT_COUNT, GOLDEN_STRATEGY_CASES } from "../src/semantics/golden-cases.js";
import { evaluateStrategyMutations } from "../src/semantics/mutation-testing.js";
import { verifyStrategySemantics } from "../src/semantics/verify-semantics.js";

const results = [];
for (const item of GOLDEN_STRATEGY_CASES) {
  const semantic = await verifyStrategySemantics(item.source, item.contract);
  const mutation = await evaluateStrategyMutations(item.source, item.contract);
  results.push({
    id: item.id,
    semanticOk: semantic.ok,
    semanticDiagnostics: semantic.diagnostics,
    scenarios: semantic.scenarios.length,
    scenariosPassed: semantic.scenarios.filter((scenario) => scenario.passed).length,
    mutants: mutation.total,
    mutantsKilled: mutation.killed,
    mutationKillRate: mutation.killRate,
    survivedMutants: mutation.results.filter((result) => !result.killed).map((result) => result.id),
  });
}

const report = {
  schemaVersion: "1.0",
  strategies: GOLDEN_STRATEGY_CASES.length,
  intents: GOLDEN_INTENT_COUNT,
  semanticPassed: results.filter((result) => result.semanticOk).length,
  scenarios: results.reduce((sum, result) => sum + result.scenarios, 0),
  scenariosPassed: results.reduce((sum, result) => sum + result.scenariosPassed, 0),
  mutants: results.reduce((sum, result) => sum + result.mutants, 0),
  mutantsKilled: results.reduce((sum, result) => sum + result.mutantsKilled, 0),
  results,
};
console.log(JSON.stringify(report, null, 2));
if (
  report.semanticPassed !== report.strategies ||
  report.scenariosPassed !== report.scenarios ||
  report.mutantsKilled !== report.mutants
) process.exitCode = 1;
