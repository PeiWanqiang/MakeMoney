export const thresholdStrategy = `
defineStrategy({
  id: "golden.threshold",
  name: "Threshold with explicit state",
  version: 1,
  onBar(ctx) {
    const entries = ctx.state.get("entries", 0);

    if (ctx.position.side === "flat" && ctx.market.close >= 101 && entries === 0) {
      ctx.state.set("entries", entries + 1);
      return {
        type: "open",
        side: "long",
        size: { kind: "riskPercent", value: 0.01 },
        stopLossPercent: 0.05,
        takeProfitRiskReward: 3,
        reason: "close crossed the configured threshold"
      };
    }

    if (ctx.position.side === "long" && ctx.market.close >= 105) {
      return { type: "close", reason: "profit threshold" };
    }

    return { type: "hold" };
  }
})
`;

export const emaFundingStrategy = `
defineStrategy({
  id: "example.ema-funding",
  name: "EMA crossover with negative funding",
  version: 1,
  onBar(ctx) {
    const fast = ctx.indicators.ema("close", 3);
    const fastPrevious = ctx.indicators.ema("close", 3, 1);
    const slow = ctx.indicators.ema("close", 5);
    const slowPrevious = ctx.indicators.ema("close", 5, 1);

    if (
      ctx.position.side === "flat" &&
      ctx.market.fundingRate < 0 &&
      ctx.crossedAbove(fast, fastPrevious, slow, slowPrevious)
    ) {
      return {
        type: "open",
        side: "long",
        size: { kind: "riskPercent", value: 0.01 },
        stopLossPercent: 0.02,
        takeProfitRiskReward: 2,
        reason: "fast EMA crossed above slow EMA while funding was negative"
      };
    }

    if (
      ctx.position.side === "long" &&
      ctx.crossedBelow(fast, fastPrevious, slow, slowPrevious)
    ) {
      return { type: "close", reason: "fast EMA crossed below slow EMA" };
    }

    return { type: "hold" };
  }
})
`;

