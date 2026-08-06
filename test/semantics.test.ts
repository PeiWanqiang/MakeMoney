import { describe, expect, it } from "vitest";

import { emaTrendStrategy } from "../examples/strategies.js";
import {
  canonicalDecision,
  canonicalRule,
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
  closeFraction: null,
};

const close: ContractDecision = {
  type: "close",
  side: null,
  sizeKind: null,
  sizeValue: null,
  stopLossPercent: null,
  takeProfitRiskReward: null,
  closeFraction: null,
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

  // Both idioms below came out of a real generation the gate refused. Neither
  // changes a value the program computes, so refusing them rejected a strategy
  // for its punctuation while telling the customer to reword a description the
  // model had already understood correctly.
  it("reads a band through ?? null and a field-level warm-up guard", async () => {
    const source = `defineStrategy({
      id: "model.bands", name: "model bands", version: 1,
      onBar(ctx) {
        const { indicators, market } = ctx;
        const lower = indicators.bollingerBands("close", 20, 2, 0)?.lower ?? null;
        const upper = indicators.bollingerBands("close", 20, 2, 0)?.upper ?? null;
        const close = market.close;
        if (lower !== null && upper !== null) {
          if (ctx.position.side === "flat" && close < lower) return {
            type: "open", side: "long", size: { kind: "riskPercent", value: 0.01 }, stopLossPercent: 0.05
          };
          if (ctx.position.side === "long" && close > upper) return { type: "close" };
        }
        return { type: "hold" };
      }
    })`;
    const extracted = extractStrategySemantics(source);
    expect(extracted.opaqueConditions).toEqual([]);
    const bandContract = readyContract("4h", [
      { when: ['position.side == "flat"', 'market.close < bollingerBands("close",20,2,0).lower'], decision: openLong },
      { when: ['position.side == "long"', 'market.close > bollingerBands("close",20,2,0).upper'], decision: close },
    ]);
    const report = await verifyStrategySemantics(source, bandContract);
    expect(report.diagnostics).toEqual([]);
    expect(report.ok).toBe(true);
  });

  // The guard is dropped because comparing an indicator to null says nothing
  // about when to trade. A comparison between two real operands still counts,
  // whatever it is written next to.
  it("drops a field-level warm-up guard without dropping the rule beside it", () => {
    const source = `defineStrategy({
      id: "model.guarded", name: "model guarded", version: 1,
      onBar(ctx) {
        const bands = ctx.indicators.bollingerBands("close", 20, 2, 0);
        const middle = bands?.middle ?? null;
        if (middle !== null && ctx.position.side === "flat" && ctx.market.close > middle) return {
          type: "open", side: "long", size: { kind: "riskPercent", value: 0.01 }, stopLossPercent: 0.05
        };
        return { type: "hold" };
      }
    })`;
    const extracted = extractStrategySemantics(source);
    expect(extracted.rules).toHaveLength(1);
    expect(extracted.rules[0]?.when).toEqual([
      'market.close > bollingerBands("close",20,2,0).middle',
      'position.side == "flat"',
    ]);
    expect(extracted.opaqueConditions).toEqual([]);
  });

  // Both engines build a timeframe view only for the intervals a contract names
  // beside its own, so this program receives null on every bar and never trades.
  // It used to surface as a heap of rule mismatches — the shape of the
  // disagreement, never its cause.
  it("names a program that reads its own timeframe through timeframe()", async () => {
    const source = `defineStrategy({
      id: "model.self", name: "model self", version: 1,
      onBar(ctx) {
        const view = ctx.timeframe("4h");
        if (view === null) return { type: "hold" };
        const rsi = view.indicators.rsi("close", 14, 0);
        if (rsi === null) return { type: "hold" };
        if (ctx.position.side === "flat" && rsi < 30) return {
          type: "open", side: "long", size: { kind: "riskPercent", value: 0.01 }, stopLossPercent: 0.05
        };
        return { type: "hold" };
      }
    })`;
    const selfContract = readyContract("4h", [
      { when: ['position.side == "flat"', 'timeframe("4h").rsi("close",14,0) < 30'], decision: openLong },
    ]);
    const report = await verifyStrategySemantics(source, selfContract);
    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toContain("SELF_TIMEFRAME_VIEW");
  });

  // The program guards on rsi at offset 0 while deciding on offset 1. Seeding
  // only the operands the contract names left that read null, so the guard held
  // and a program matching its contract rule for rule failed every scenario.
  it("seeds indicators the program reads but the contract never names", async () => {
    const source = `defineStrategy({
      id: "model.extra", name: "model extra", version: 1,
      onBar(ctx) {
        const rsiNow = ctx.indicators.rsi("close", 14);
        const rsiPrevious = ctx.indicators.rsi("close", 14, 1);
        const atr = ctx.indicators.atr(14);
        if (rsiNow === null || rsiPrevious === null || atr === null) return { type: "hold" };
        if (ctx.position.side === "flat" && rsiPrevious < 30) return {
          type: "open", side: "long", size: { kind: "riskPercent", value: 0.01 }, stopLossPercent: 0.05
        };
        return { type: "hold" };
      }
    })`;
    const extraContract = readyContract("4h", [
      { when: ['position.side == "flat"', 'rsi("close",14,1) < 30'], decision: openLong },
    ]);
    const report = await verifyStrategySemantics(source, extraContract);
    expect(report.diagnostics).toEqual([]);
    expect(report.scenarios.every((scenario) => scenario.passed)).toBe(true);
    expect(report.ok).toBe(true);
  });

  describe("partial exits", () => {
    // Scale out half at the middle band, flatten at the upper band. Two guards
    // earn their keep: the state flag stops the partial leg from firing again
    // on every later bar, and the upper-band bound keeps it from overlapping
    // the full exit — the contract is an unordered rule set, so a rule cannot
    // rely on being tested after another one.
    const scaleOutSource = `defineStrategy({
      id: "model.scale-out", name: "scale out", version: 1,
      onBar(context) {
        const bands = context.indicators.bollingerBands("close", 20, 2, 0);
        const scaledOut = context.state.get("scaledOut", 0);
        if (bands === null) return { type: "hold" };
        if (context.position.side === "flat" && context.market.close < bands.lower) {
          context.state.set("scaledOut", 0);
          return { type: "open", side: "long", size: { kind: "riskPercent", value: 0.01 }, stopLossPercent: 0.05 };
        }
        if (context.position.side === "long" && context.market.close > bands.upper) return { type: "close" };
        if (
          context.position.side === "long" && context.market.close > bands.middle
          && context.market.close <= bands.upper && scaledOut === 0
        ) {
          context.state.set("scaledOut", 1);
          return { type: "close", fraction: 0.5 };
        }
        return { type: "hold" };
      }
    })`;
    const scaleOutContract = readyContract("1h", [
      {
        when: ['position.side == "flat"', 'market.close < bollingerBands("close",20,2,0).lower'],
        decision: openLong,
      },
      {
        when: ['position.side == "long"', 'market.close > bollingerBands("close",20,2,0).upper'],
        decision: close,
      },
      {
        when: [
          'position.side == "long"',
          'market.close > bollingerBands("close",20,2,0).middle',
          'market.close <= bollingerBands("close",20,2,0).upper',
          "state.scaledOut == 0",
        ],
        decision: { ...close, closeFraction: 0.5 },
      },
    ]);

    it("reverse extracts the closed share from the program", () => {
      const extracted = extractStrategySemantics(scaleOutSource);
      expect(extracted.opaqueConditions).toEqual([]);
      expect(extracted.rules.map((rule) => rule.decision.closeFraction)).toEqual(
        expect.arrayContaining([0.5, null, null]),
      );
    });

    it("verifies a scale-out program against its contract", async () => {
      const report = await verifyStrategySemantics(scaleOutSource, scaleOutContract);
      expect(report.diagnostics).toEqual([]);
      expect(report.ok).toBe(true);
    });

    it("rejects a program that flattens where the contract promised half", async () => {
      const mutated = scaleOutSource.replace('{ type: "close", fraction: 0.5 }', '{ type: "close" }');
      const report = await verifyStrategySemantics(mutated, scaleOutContract);
      expect(report.ok).toBe(false);
    });

    it("treats fraction 1 and an absent fraction as the same whole exit", () => {
      const spelled = extractStrategySemantics(scaleOutSource.replace('{ type: "close" }', '{ type: "close", fraction: 1 }'));
      const implied = extractStrategySemantics(scaleOutSource);
      expect(spelled.rules.map(canonicalRule).sort()).toEqual(implied.rules.map(canonicalRule).sort());
    });
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

  it("normalizes SDK object prefixes out of audit conditions", () => {
    const prefixed = readyContract("1h", [{
      when: ['position.side == "flat"', 'context.indicators.percentChange("close",20) < -0.05'],
      decision: openLong,
    }]);
    expect(prefixed.rules[0]?.when).toContain('percentChange("close",20) < -0.05');
    expect(compareStrategyContracts(prefixed, readyContract("1h", [{
      when: ['position.side == "flat"', 'percentChange("close",20) < -0.05'],
      decision: openLong,
    }]))).toEqual([]);
  });

  // The prompt has always offered arithmetic operands, but nothing could extract
  // them: a condition using one was recorded as opaque, which made the verify
  // gate refuse the strategy. Every such intent was rejected on arrival.
  it("extracts arithmetic operands instead of treating them as opaque", async () => {
    const source = `defineStrategy({
      id: "test.buffered-breakout",
      name: "Buffered breakout",
      version: 1,
      onBar(ctx) {
        const priorHigh = ctx.indicators.highest("high", 20, 1);
        const atr = ctx.indicators.atr(14);
        if (priorHigh === null || atr === null) return { type: "hold" };
        if (ctx.position.side === "flat" && ctx.market.close > priorHigh * 1.02) {
          return { type: "open", side: "long", size: { kind: "riskPercent", value: 0.01 }, stopLossPercent: 0.05 };
        }
        if (ctx.position.side === "long" && ctx.market.close < priorHigh - atr * 2) {
          return { type: "close", reason: "pullback" };
        }
        return { type: "hold" };
      }
    })`;
    const arithmeticContract = readyContract("1h", [
      { when: ['position.side == "flat"', 'market.close > highest("high",20,1)*1.02'], decision: openLong },
      {
        when: ['position.side == "long"', 'market.close < highest("high",20,1)-atr(14,0)*2'],
        decision: { type: "close", side: null, sizeKind: null, sizeValue: null, stopLossPercent: null, takeProfitRiskReward: null, closeFraction: null },
      },
    ]);
    const report = await verifyStrategySemantics(source, arithmeticContract);
    expect(report.extracted.opaqueConditions).toEqual([]);
    expect(report.diagnostics).toEqual([]);
    expect(report.scenarios.every((scenario) => scenario.passed)).toBe(true);
    expect(report.ok).toBe(true);
  });

  // Redundant grouping must not read as a different rule: the contract carries
  // the model's spelling while the program carries its own.
  it("treats equivalent parenthesizations of one expression as the same rule", () => {
    const grouped = readyContract("1h", [{
      when: ['market.close < highest("high",20,1)-(atr(14,0)*2)'],
      decision: openLong,
    }]);
    const flat = readyContract("1h", [{
      when: ['market.close < highest("high",20,1)-atr(14,0)*2'],
      decision: openLong,
    }]);
    expect(compareStrategyContracts(grouped, flat)).toEqual([]);
  });
});

// A stop sized from ATR is not a new kind of field, it is an operand the
// contract grammar can already spell. Quantifying it as an expression is what
// lets the gate check the calculation rather than only a number it produced.
describe("expression-valued decision fields", () => {
  const atrStopSource = `defineStrategy({
    id: "test.atr-stop",
    name: "ATR-sized stop",
    version: 1,
    onBar(ctx) {
      const rsi = ctx.indicators.rsi("close", 14);
      const atr = ctx.indicators.atr(14);
      if (rsi === null || atr === null) return { type: "hold" };
      if (ctx.position.side === "flat" && rsi < 30) {
        return {
          type: "open",
          side: "long",
          size: { kind: "riskPercent", value: 0.01 },
          stopLossPercent: atr / ctx.market.close * 2,
          takeProfitRiskReward: 2
        };
      }
      return { type: "hold" };
    }
  })`;

  const atrStopContract = (stop: string | number) => readyContract("1h", [{
    when: ['position.side == "flat"', 'rsi("close",14,0) < 30'],
    decision: {
      type: "open", side: "long", sizeKind: "riskPercent", sizeValue: 0.01,
      stopLossPercent: stop, takeProfitRiskReward: 2, closeFraction: null,
    },
  }]);

  it("extracts a computed stop as a canonical expression", () => {
    const extracted = extractStrategySemantics(atrStopSource);
    expect(extracted.rules[0]?.decision.stopLossPercent).toBe("2*atr(14,0)/market.close");
  });

  // The contract carries the model's spelling and the program carries its own,
  // and the two are compared as text. Without algebraic normalization an
  // ATR-sized stop verified only when the model happened to write both sides the
  // same way, which is a coin flip rather than a feature.
  it("accepts any equivalent spelling of one calculation on either side", async () => {
    const programSpellings = ["atr / ctx.market.close * 2", "2 * atr / ctx.market.close", "(atr * 2) / ctx.market.close"];
    const contractSpellings = ["atr(14,0)/market.close*2", "2*atr(14,0)/market.close", "atr(14,0)*2/market.close"];
    for (const programStop of programSpellings) {
      const source = atrStopSource.replace("atr / ctx.market.close * 2", programStop);
      for (const contractStop of contractSpellings) {
        const report = await verifyStrategySemantics(source, atrStopContract(contractStop));
        expect(report.ok, `program "${programStop}" vs contract "${contractStop}": ${JSON.stringify(report.diagnostics)}`).toBe(true);
      }
    }
  });

  // Reordering must not become "close enough": distribution changes the floating
  // point result, so those two spellings really are different calculations.
  it("does not unify expressions that compute different values", () => {
    const grouped = readyContract("1h", [{
      when: ['(market.high-market.low)/market.close > 0.02'],
      decision: openLong,
    }]);
    const distributed = readyContract("1h", [{
      when: ['market.high/market.close-market.low/market.close > 0.02'],
      decision: openLong,
    }]);
    expect(compareStrategyContracts(grouped, distributed)).not.toEqual([]);
  });

  it("verifies a program whose stop is computed from ATR", async () => {
    const report = await verifyStrategySemantics(atrStopSource, atrStopContract("atr(14,0)/market.close*2"));
    expect(report.diagnostics).toEqual([]);
    expect(report.ok).toBe(true);
  });

  // The point of quantifying the calculation: a contract claiming a different
  // multiplier than the program uses has to be caught, or the expression would
  // have bought expressiveness by giving up the check.
  it("rejects a contract whose stop multiplier differs from the program", async () => {
    const report = await verifyStrategySemantics(atrStopSource, atrStopContract("atr(14,0)/market.close*3"));
    expect(report.ok).toBe(false);
  });

  it("rejects a contract that reduces a computed stop to a constant", async () => {
    const report = await verifyStrategySemantics(atrStopSource, atrStopContract(0.05));
    expect(report.ok).toBe(false);
  });

  it("keeps a constant stop as a number so stored contracts read back unchanged", () => {
    const constant = readyContract("1h", [{ when: ['position.side == "flat"'], decision: openLong }]);
    expect(constant.rules[0]?.decision.stopLossPercent).toBe(0.05);
    expect(canonicalDecision(constant.rules[0]!.decision)).toContain('"stopLossPercent":0.05');
  });

  it("collapses an expression that is really a constant", () => {
    const spelled = readyContract("1h", [{
      when: ['position.side == "flat"'],
      decision: { ...openLong, stopLossPercent: "0.05" },
    }]);
    expect(canonicalDecision(spelled.rules[0]!.decision)).toBe(canonicalDecision(openLong));
  });
});
