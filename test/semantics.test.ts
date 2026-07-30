import { describe, expect, it } from "vitest";

import { emaTrendStrategy } from "../examples/strategies.js";
import {
  compareStrategyContracts,
  normalizeContract,
  readyContract,
  type ContractDecision,
} from "../src/semantics/contract.js";
import { extractStrategySemantics } from "../src/semantics/extract-semantics.js";
import { evaluateStrategyMutations } from "../src/semantics/mutation-testing.js";
import { verifyStrategySemantics } from "../src/semantics/verify-semantics.js";

const openLong: ContractDecision = {
  type: "open",
  side: "long",
  sizeKind: "riskPercent",
  sizeValue: 0.01,
  stopLossPercent: 0.05,
  takeProfitRiskReward: null,
};

const close: ContractDecision = {
  type: "close",
  side: null,
  sizeKind: null,
  sizeValue: null,
  stopLossPercent: null,
  takeProfitRiskReward: null,
};

const contract = readyContract("4h", [
  {
    when: [
      'position.side == "flat"',
      'crossAbove(ema("close",20,0),ema("close",20,1),ema("close",50,0),ema("close",50,1))',
    ],
    decision: openLong,
  },
  {
    when: [
      'position.side == "long"',
      'crossBelow(ema("close",20,0),ema("close",20,1),ema("close",50,0),ema("close",50,1))',
    ],
    decision: close,
  },
]);

describe("strategy semantic verification", () => {
  it("reverse extracts contracted rules from strategy code", () => {
    const extracted = extractStrategySemantics(emaTrendStrategy);
    expect(extracted.opaqueConditions).toEqual([]);
    expect(extracted.rules).toHaveLength(2);
    expect(extracted.rules).toEqual(expect.arrayContaining(contract.rules));
  });

  it("passes positive and condition-negated behavior scenarios", async () => {
    const report = await verifyStrategySemantics(emaTrendStrategy, contract);
    expect(report.diagnostics).toEqual([]);
    expect(report.scenarios).toHaveLength(6);
    expect(report.scenarios.every((scenario) => scenario.passed)).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("rejects a semantically changed stop even though the program still compiles", async () => {
    const mutated = emaTrendStrategy.replace("stopLossPercent: 0.05", "stopLossPercent: 0.5");
    const report = await verifyStrategySemantics(mutated, contract);
    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["MISSING_CONTRACT_RULE", "UNEXPECTED_PROGRAM_RULE"]),
    );
  });

  it("kills compilable semantic mutants", async () => {
    const report = await evaluateStrategyMutations(emaTrendStrategy, contract);
    expect(report.total).toBeGreaterThanOrEqual(5);
    expect(report.compiled).toBeGreaterThanOrEqual(4);
    expect(report.survived).toBe(0);
    expect(report.killRate).toBe(1);
  });

  it("normalizes model-style null guards and position aliases", async () => {
    const source = `defineStrategy({
      id: "model.atr", name: "model ATR", version: 1,
      onBar(context) {
        const pos = context.position;
        const fast = context.indicators.ema("close", 20, 0);
        const fastPrevious = context.indicators.ema("close", 20, 1);
        const slow = context.indicators.ema("close", 50, 0);
        const slowPrevious = context.indicators.ema("close", 50, 1);
        const atr = context.indicators.atr(14, 0);
        if (fast != null && fastPrevious != null && slow != null && slowPrevious != null && atr != null) {
          const crossUp = context.crossedAbove(fast, fastPrevious, slow, slowPrevious);
          if (pos.side === "flat" && crossUp && atr > 100) return {
            type: "open", side: "long", size: { kind: "riskPercent", value: 0.01 }, stopLossPercent: 0.05
          };
          const crossDown = context.crossedBelow(fast, fastPrevious, slow, slowPrevious);
          if (pos.side === "long" && crossDown) return { type: "close" };
        }
        return { type: "hold" };
      }
    })`;
    const atrContract = readyContract("4h", [
      {
        when: [
          'position.side == "flat"',
          'crossAbove(ema("close",20,0),ema("close",20,1),ema("close",50,0),ema("close",50,1))',
          "atr(14,0) > 100",
        ],
        decision: openLong,
      },
      {
        when: [
          'position.side == "long"',
          'crossBelow(ema("close",20,0),ema("close",20,1),ema("close",50,0),ema("close",50,1))',
        ],
        decision: close,
      },
    ]);
    const report = await verifyStrategySemantics(source, atrContract);
    expect(report.diagnostics).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("ignores non-semantic whitespace inside canonical contract conditions", async () => {
    const spaced = readyContract("4h", contract.rules.map((rule) => ({
      ...rule,
      when: rule.when.map((condition) => condition.replaceAll(",", ", ")),
    })));
    const report = await verifyStrategySemantics(emaTrendStrategy, spaced);
    expect(report.diagnostics).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("normalizes common model spellings of cross conditions", () => {
    const normalized = normalizeContract(readyContract("15m", [{
      when: [
        'position.side == "flat"',
        'timeframe("1h").crossedAbove(ema("close",20,0), ema("close",20,1), ema("close",50,0), ema("close",50,1))',
      ],
      decision: openLong,
    }]));
    expect(normalized.rules[0]?.when).toContain(
      'crossAbove(timeframe("1h").ema("close",20,0),timeframe("1h").ema("close",20,1),timeframe("1h").ema("close",50,0),timeframe("1h").ema("close",50,1))',
    );
  });

  it("reverse extracts context object destructuring", async () => {
    const source = emaTrendStrategy
      .replace("onBar(ctx) {", "onBar(context) { const { position, indicators } = context;")
      .replaceAll("ctx.indicators", "indicators")
      .replaceAll("ctx.position", "position")
      .replaceAll("ctx.crossed", "context.crossed");
    const report = await verifyStrategySemantics(source, contract);
    expect(report.diagnostics).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("runs compact comparisons with positive-valued cross scenarios", async () => {
    const guarded = emaTrendStrategy.replace(
      'const fastPrevious = ctx.indicators.ema("close", 20, 1);',
      'const fastPrevious = ctx.indicators.ema("close", 20, 1);\n    if (!fastPrevious) return { type: "hold" };',
    );
    const compact = readyContract("4h", contract.rules.map((rule) => ({
      ...rule,
      when: rule.when.map((condition) => condition.replaceAll(" == ", "==")),
    })));
    const report = await verifyStrategySemantics(guarded, compact);
    expect(report.diagnostics).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("treats reversed relational operands as the same condition", () => {
    const expected = readyContract("4h", [{
      when: ['market.close < bollingerBands("close",20,2,0).lower'],
      decision: openLong,
    }]);
    const reversed = readyContract("4h", [{
      when: ['bollingerBands("close",20,2,0).lower > market.close'],
      decision: openLong,
    }]);
    expect(compareStrategyContracts(expected, reversed)).toEqual([]);
  });
});
