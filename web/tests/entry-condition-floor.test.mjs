import assert from "node:assert/strict";
import test from "node:test";

import { enforceEntryConditionFloor } from "../worker/entry-condition-floor.ts";

/**
 * The floor exists because a model that loses the user's intent produces a
 * structurally valid contract that opens on every bar. Nothing downstream can
 * tell that apart from a strategy the user actually described, so it is caught
 * here and turned into a question rather than a silent `ready`.
 */

function readyArtifact(when) {
  return {
    status: "ready",
    source: "defineStrategy({ id: \"x\", name: \"x\", version: 1, onBar() {} })",
    clarificationQuestions: [],
    contract: {
      schemaVersion: "1.0",
      timeframe: "4h",
      rules: [{ when, decision: { type: "open", side: "long", sizeKind: "riskPercent", sizeValue: 0.01, stopLossPercent: 0.05, takeProfitRiskReward: null } }],
      unsupportedCapabilities: [],
    },
  };
}

test("an open rule with no market condition becomes a question, not a ready strategy", () => {
  const artifact = readyArtifact(["position.side == \"flat\""]);
  enforceEntryConditionFloor(artifact, "zh-CN");

  assert.equal(artifact.status, "needs_clarification");
  assert.equal(artifact.contract, null);
  assert.equal(artifact.source, "");
  assert.equal(artifact.clarificationQuestions.length, 1);
});

test("an indicator condition keeps the strategy ready", () => {
  const artifact = readyArtifact(["position.side == \"flat\"", "rsi(\"close\",14,0) < 30"]);
  enforceEntryConditionFloor(artifact, "zh-CN");

  assert.equal(artifact.status, "ready");
  assert.notEqual(artifact.contract, null);
});

test("a bare market field counts as an entry condition", () => {
  const artifact = readyArtifact(["market.close > 100"]);
  enforceEntryConditionFloor(artifact, "en");

  assert.equal(artifact.status, "ready");
});

test("a cross event counts as an entry condition", () => {
  const artifact = readyArtifact(["crossAbove(ema(\"close\",20,0),ema(\"close\",20,1),ema(\"close\",50,0),ema(\"close\",50,1))"]);
  enforceEntryConditionFloor(artifact, "en");

  assert.equal(artifact.status, "ready");
});

test("account and state conditions alone do not count as market conditions", () => {
  for (const when of [["account.equity > 1000"], ["state.losses < 3"], []]) {
    const artifact = readyArtifact(when);
    enforceEntryConditionFloor(artifact, "en");
    assert.equal(artifact.status, "needs_clarification", `expected a question for ${JSON.stringify(when)}`);
  }
});

test("a close rule without a market condition is left alone", () => {
  const artifact = {
    status: "ready",
    source: "defineStrategy({})",
    clarificationQuestions: [],
    contract: {
      schemaVersion: "1.0",
      timeframe: "4h",
      rules: [
        { when: ["rsi(\"close\",14,0) < 30"], decision: { type: "open", side: "long", sizeKind: "riskPercent", sizeValue: 0.01, stopLossPercent: 0.05, takeProfitRiskReward: null } },
        { when: ["position.side == \"long\""], decision: { type: "close", side: null, sizeKind: null, sizeValue: null, stopLossPercent: null, takeProfitRiskReward: null } },
      ],
      unsupportedCapabilities: [],
    },
  };
  enforceEntryConditionFloor(artifact, "en");

  assert.equal(artifact.status, "ready");
});

test("the question is written in the requested language", () => {
  const chinese = readyArtifact(["position.side == \"flat\""]);
  enforceEntryConditionFloor(chinese, "zh-CN");
  assert.match(chinese.clarificationQuestions[0], /入场/);

  const english = readyArtifact(["position.side == \"flat\""]);
  enforceEntryConditionFloor(english, "en");
  assert.match(english.clarificationQuestions[0], /entry/i);
});

test("artifacts that are not ready pass through untouched", () => {
  const artifact = { status: "unsupported", contract: null, source: "", clarificationQuestions: [], unsupportedCapabilities: ["options data"] };
  enforceEntryConditionFloor(artifact, "en");

  assert.equal(artifact.status, "unsupported");
  assert.deepEqual(artifact.clarificationQuestions, []);
});
