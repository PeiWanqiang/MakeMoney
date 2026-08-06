import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { thresholdStrategy } from "../examples/strategies.js";
import { ScriptedStrategyProgramProvider } from "../src/studio/scripted-provider.js";
import { FileStrategySessionStore } from "../src/studio/session-store.js";
import { StrategyStudio } from "../src/studio/strategy-studio.js";
import type { StrategyProviderResponse } from "../src/studio/types.js";
import { readyContract } from "../src/semantics/contract.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function response(source: string, changeSummary: string): StrategyProviderResponse {
  const stopLossPercent = source.includes("stopLossPercent: 0.03") ? 0.03 : 0.05;
  return {
    provider: "scripted",
    model: "fixture-v1",
    responseId: `response-${changeSummary}`,
    artifact: {
      status: "ready",
      source,
      contract: readyContract("4h", [
        {
          when: ['market.close >= 101', 'position.side == "flat"', 'state.entries == 0'],
          decision: {
            type: "open", side: "long", sizeKind: "riskPercent", sizeValue: 0.01,
            stopLossPercent, takeProfitRiskReward: 3, closeFraction: null,
          },
        },
        {
          when: ['market.close >= 105', 'position.side == "long"'],
          decision: {
            type: "close", side: null, sizeKind: null, sizeValue: null,
            stopLossPercent: null, takeProfitRiskReward: null, closeFraction: null,
          },
        },
      ]),
      explanation: "A deterministic threshold strategy.",
      assumptions: ["Signals use closed bars."],
      warnings: [],
      changeSummary,
    },
  };
}

describe("strategy studio product loop", () => {
  it("repairs compiler errors and preserves immutable versions across a user revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "strategy-studio-"));
    temporaryDirectories.push(directory);
    const invalidSource = `defineStrategy({
      id: "golden.threshold",
      name: "Threshold with explicit state",
      version: 1,
      onBar(ctx) {
        const stochastic = ctx.indicators.stochastic(14);
        return { type: "hold", reason: String(stochastic) };
      }
    })`;
    const revisedSource = thresholdStrategy
      .replace("version: 1", "version: 2")
      .replace("stopLossPercent: 0.05", "stopLossPercent: 0.03");
    const provider = new ScriptedStrategyProgramProvider([
      response(invalidSource, "Initial candidate"),
      response(thresholdStrategy, "Repaired unsupported indicator call"),
      response(revisedSource, "Changed stop loss from 5% to 3%"),
    ]);
    const store = new FileStrategySessionStore(directory);
    const studio = new StrategyStudio({ provider, store, maxRepairAttempts: 2 });

    const created = await studio.create({
      sessionId: "test-session",
      intent: "收盘价达到 101 时做多，止损 5%，价格达到 105 时平仓",
    });
    expect(created.version.generation.repairCount).toBe(1);
    expect(created.version.failedCompilationAttempts[0]?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "TS2339" })]),
    );
    expect(provider.requests.map((request) => request.mode)).toEqual(["create", "repair"]);
    expect(provider.requests[1]?.compilerDiagnostics?.[0]).toMatchObject({ code: "TS2339" });

    const firstVersionPath = join(directory, "test-session", "versions", `${created.version.versionId}.json`);
    const firstVersionBeforeRevision = await readFile(firstVersionPath, "utf8");
    const revised = await studio.revise({ sessionId: "test-session", intent: "把止损改成 3%" });

    expect(revised.version.ordinal).toBe(2);
    expect(revised.version.parentVersionId).toBe(created.version.versionId);
    expect(revised.version.source).toContain("stopLossPercent: 0.03");
    expect(revised.version.sourceDiff.removed).toContain("        stopLossPercent: 0.05,");
    expect(revised.version.sourceDiff.added).toContain("        stopLossPercent: 0.03,");
    expect(revised.session.versionIds).toEqual([created.version.versionId, revised.version.versionId]);
    expect(await readFile(firstVersionPath, "utf8")).toBe(firstVersionBeforeRevision);
    expect(provider.requests.map((request) => request.mode)).toEqual(["create", "repair", "revise"]);
    expect(provider.requests[2]?.currentSource).toBe(thresholdStrategy);
  });
});
