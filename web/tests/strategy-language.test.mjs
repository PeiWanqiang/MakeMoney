import assert from "node:assert/strict";
import test from "node:test";

import { en } from "../app/i18n/en.ts";
import { zh } from "../app/i18n/zh.ts";
import { describeCondition, describeRules, humanizeExpression, timeframeLabel } from "../app/strategy-language.ts";

test("translates position, comparison and crossing conditions into readable sentences", () => {
  assert.equal(describeCondition(zh, 'position.side == "flat"'), "当前空仓");
  assert.equal(describeCondition(zh, 'position.side == "short"'), "当前持有空单");
  assert.equal(describeCondition(zh, 'rsi("close",14,0) < 30'), "14 周期 RSI 低于 30");
  assert.equal(describeCondition(zh, 'market.close >= sma("close",200,0)'), "收盘价 不低于 200 周期收盘价均线");
  assert.equal(
    describeCondition(zh, 'crossAbove(ema("close",9,0),ema("close",9,1),ema("close",21,0),ema("close",21,1))'),
    "9 周期收盘价指数均线 上穿 21 周期收盘价指数均线",
  );
});

test("keeps arithmetic, lag, multi-timeframe and composite indicators readable", () => {
  assert.equal(describeCondition(zh, 'market.close > market.close * 1.02'), "收盘价 高于 收盘价 × 1.02");
  assert.match(describeCondition(zh, 'atr(14,0) > atr(14,1)'), /14 周期 ATR 波动幅度 高于 14 周期 ATR 波动幅度（1 根之前）/);
  assert.match(describeCondition(zh, 'timeframe("4h").market.close > timeframe("4h").sma("close",50,0)'), /4 小时周期的收盘价 高于/);
  assert.match(describeCondition(zh, 'macd("close",12,26,9,0).histogram > 0'), /MACD 柱状值（12、26、9） 高于 0/);
  assert.match(describeCondition(zh, 'market.close < bollingerBands("close",20,2,0).lower'), /布林带下轨（20 周期，2 倍标准差）/);
});

test("never invents meaning for an unknown expression", () => {
  const unknown = "someFutureIndicator(\"close\",7) is rising";
  assert.equal(describeCondition(zh, unknown), humanizeExpression(zh, unknown));
  assert.match(describeCondition(zh, unknown), /someFutureIndicator/);
});

test("projects contract rules into entry and exit cards with plain risk wording", () => {
  const rules = describeRules(zh, [
    {
      when: ['position.side == "flat"', 'rsi("close",14,0) < 30'],
      decision: { type: "open", side: "long", sizeKind: "riskPercent", sizeValue: 0.01, stopLossPercent: 0.05, takeProfitRiskReward: 2 },
    },
    {
      when: ['position.side == "long"', 'rsi("close",14,0) > 55'],
      decision: { type: "close", side: null, sizeKind: null, sizeValue: null, stopLossPercent: null, takeProfitRiskReward: null },
    },
  ]);

  assert.equal(rules.length, 2);
  assert.equal(rules[0].kind, "entry");
  assert.equal(rules[0].badge, "入场");
  assert.equal(rules[0].action, "买入开多");
  assert.equal(rules[0].state, "当前空仓");
  assert.deepEqual(rules[0].signals, ["14 周期 RSI 低于 30"]);
  assert.deepEqual(rules[0].risk, ["单笔最多亏掉账户的 1%", "价格反向走 5% 就止损", "赚到风险的 2 倍就止盈"]);
  assert.equal(rules[1].kind, "exit");
  assert.equal(rules[1].action, "平掉当前仓位");
  assert.equal(rules[1].risk.length, 0);
});

test("describes every supported sizing kind and tolerates a missing contract", () => {
  const [equityRule] = describeRules(zh, [
    { when: ['position.side == "flat"'], decision: { type: "open", side: "short", sizeKind: "equityPercent", sizeValue: 0.25, stopLossPercent: null, takeProfitRiskReward: null } },
  ]);
  assert.equal(equityRule.action, "卖出开空");
  assert.deepEqual(equityRule.risk, ["用账户权益的 25% 开仓"]);

  const [notionalRule] = describeRules(zh, [
    { when: [], decision: { type: "open", side: "long", sizeKind: "fixedNotional", sizeValue: 1000, stopLossPercent: 0.03, takeProfitRiskReward: null } },
  ]);
  assert.deepEqual(notionalRule.risk, ["每次固定 1000 USDT 仓位", "价格反向走 3% 就止损"]);
  assert.equal(notionalRule.state, null);

  assert.deepEqual(describeRules(zh, undefined), []);
  assert.deepEqual(describeRules(zh, null), []);
});

test("labels timeframes for the customer instead of leaking raw codes", () => {
  assert.equal(timeframeLabel(zh, "1h"), "1 小时 K 线");
  assert.equal(timeframeLabel(zh, "15m"), "15 分钟 K 线");
  assert.equal(timeframeLabel(zh, undefined), "所选周期的 K 线");
});

test("renders the same contract in English without reusing Chinese word order", () => {
  assert.equal(describeCondition(en, 'position.side == "flat"'), "currently flat");
  assert.equal(describeCondition(en, 'rsi("close",14,0) < 30'), "14-period RSI is below 30");
  assert.equal(
    describeCondition(en, 'market.close >= sma("close",200,0)'),
    "close is at least 200-period close SMA",
  );
  assert.equal(
    describeCondition(en, 'crossAbove(ema("close",9,0),ema("close",9,1),ema("close",21,0),ema("close",21,1))'),
    "9-period close EMA crosses above 21-period close EMA",
  );
  assert.match(describeCondition(en, 'atr(14,0) > atr(14,1)'), /14-period ATR is above 14-period ATR \(1 bars ago\)/);
  assert.match(describeCondition(en, 'market.close > highest("high",20,1)'), /highest high of the last 20 bars/);

  const [entry] = describeRules(en, [{
    when: ['position.side == "flat"', 'rsi("close",14,0) < 30'],
    decision: { type: "open", side: "long", sizeKind: "riskPercent", sizeValue: 0.01, stopLossPercent: 0.05, takeProfitRiskReward: 2 },
  }]);
  assert.equal(entry.badge, "Entry");
  assert.equal(entry.action, "open a long position");
  assert.deepEqual(entry.risk, [
    "risk at most 1% of the account per trade",
    "stop out after a 5% adverse move",
    "take profit at 2× the risk",
  ]);
  assert.equal(timeframeLabel(en, "4h"), "4-hour candles");
});

test("an unknown expression is never given an invented meaning in either locale", () => {
  const unknown = 'someFutureIndicator("close",7) is rising';
  for (const catalogue of [zh, en]) {
    assert.equal(describeCondition(catalogue, unknown), humanizeExpression(catalogue, unknown));
    assert.match(describeCondition(catalogue, unknown), /someFutureIndicator/);
  }
});
