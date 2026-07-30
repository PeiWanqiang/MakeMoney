import { readyContract, type ContractDecision, type ContractTimeframe, type StrategyContract } from "./contract.js";

export interface GoldenStrategyCase {
  id: string;
  title: string;
  source: string;
  contract: StrategyContract;
  intents: readonly [string, string, string, string, string];
}

interface ConditionPair {
  source: string;
  contract: string;
}

interface GoldenInput {
  id: string;
  title: string;
  timeframe: ContractTimeframe;
  chinese: string;
  english: string;
  declarations: string;
  entry: ConditionPair[];
  exit: ConditionPair[];
  side: "long" | "short";
  sizeKind?: "riskPercent" | "fixedNotional";
  sizeValue?: number;
  stopLossPercent?: number;
  takeProfitRiskReward?: number;
}

const closeDecision: ContractDecision = {
  type: "close", side: null, sizeKind: null, sizeValue: null, stopLossPercent: null, takeProfitRiskReward: null,
};

function intents(chinese: string, english: string, executionChinese: string, executionEnglish: string): GoldenStrategyCase["intents"] {
  const completeChinese = `${chinese}；${executionChinese}`;
  const completeEnglish = `${english} ${executionEnglish}`;
  return [
    completeChinese,
    `严格按以下规则执行，不要添加额外条件：${completeChinese}`,
    `帮我做一个策略：${completeChinese}`,
    completeEnglish,
    `Use closed bars and do not add filters. ${completeEnglish}`,
  ];
}

function golden(input: GoldenInput): GoldenStrategyCase {
  const sizeKind = input.sizeKind ?? "riskPercent";
  const sizeValue = input.sizeValue ?? 0.01;
  const stopLossPercent = input.stopLossPercent ?? 0.05;
  const takeProfit = input.takeProfitRiskReward;
  const sizeChinese = sizeKind === "riskPercent"
    ? `每次交易按账户权益风险${sizeValue * 100}%`
    : `每次使用固定名义仓位${sizeValue}`;
  const sizeEnglish = sizeKind === "riskPercent"
    ? `Risk ${sizeValue * 100}% of account equity per trade`
    : `Use fixed notional size ${sizeValue} per trade`;
  const executionChinese = `${sizeChinese}，止损${stopLossPercent * 100}%，${takeProfit === undefined ? "不设置额外止盈" : `止盈为${takeProfit}R`}`;
  const executionEnglish = `${sizeEnglish}, use a ${stopLossPercent * 100}% stop, and ${takeProfit === undefined ? "do not add a separate take-profit" : `take profit at ${takeProfit}R`}.`;
  const openDecision: ContractDecision = {
    type: "open",
    side: input.side,
    sizeKind,
    sizeValue,
    stopLossPercent,
    takeProfitRiskReward: takeProfit ?? null,
  };
  const entrySource = input.entry.map((condition) => `      ${condition.source}`).join(" &&\n");
  const exitSource = input.exit.map((condition) => `      ${condition.source}`).join(" &&\n");
  const source = `defineStrategy({
  id: "golden.${input.id}",
  name: ${JSON.stringify(input.title)},
  version: 1,
  onBar(ctx) {
${input.declarations.split("\n").map((line) => `    ${line}`).join("\n")}
    if (
      ctx.position.side === "flat" &&
${entrySource}
    ) {
      return {
        type: "open",
        side: "${input.side}",
        size: { kind: "${sizeKind}", value: ${sizeValue} },
        stopLossPercent: ${stopLossPercent},${takeProfit === undefined ? "" : `\n        takeProfitRiskReward: ${takeProfit},`}
        reason: "golden entry"
      };
    }
    if (
      ctx.position.side === "${input.side}" &&
${exitSource}
    ) return { type: "close", reason: "golden exit" };
    return { type: "hold" };
  }
})`;
  return {
    id: input.id,
    title: input.title,
    source,
    contract: readyContract(input.timeframe, [
      {
        when: ['position.side == "flat"', ...input.entry.map((condition) => condition.contract)],
        decision: openDecision,
      },
      {
        when: [`position.side == "${input.side}"`, ...input.exit.map((condition) => condition.contract)],
        decision: closeDecision,
      },
    ]),
    intents: intents(input.chinese, input.english, executionChinese, executionEnglish),
  };
}

const emaCross = (fast: number, slow: number, direction: "Above" | "Below", prefix = "ctx"): ConditionPair => ({
  source: `${prefix}.crossed${direction}(fast, fastPrevious, slow, slowPrevious)`,
  contract: `cross${direction}(ema("close",${fast},0),ema("close",${fast},1),ema("close",${slow},0),ema("close",${slow},1))`,
});

const smaCross = (fast: number, slow: number, direction: "Above" | "Below"): ConditionPair => ({
  source: `ctx.crossed${direction}(fast, fastPrevious, slow, slowPrevious)`,
  contract: `cross${direction}(sma("close",${fast},0),sma("close",${fast},1),sma("close",${slow},0),sma("close",${slow},1))`,
});

export const GOLDEN_STRATEGY_CASES: GoldenStrategyCase[] = [
  golden({
    id: "ema-20-50-long", title: "EMA 20/50 Long Crossover", timeframe: "4h", side: "long",
    chinese: "4小时20 EMA上穿50 EMA做多，死叉平仓，风险1%，止损5%", english: "On 4h bars, go long on EMA 20 crossing above EMA 50 and close on the reverse cross; risk 1% with a 5% stop.",
    declarations: 'const fast = ctx.indicators.ema("close", 20);\nconst fastPrevious = ctx.indicators.ema("close", 20, 1);\nconst slow = ctx.indicators.ema("close", 50);\nconst slowPrevious = ctx.indicators.ema("close", 50, 1);',
    entry: [emaCross(20, 50, "Above")], exit: [emaCross(20, 50, "Below")],
  }),
  golden({
    id: "ema-10-30-short", title: "EMA 10/30 Short Crossover", timeframe: "1h", side: "short", stopLossPercent: 0.04,
    chinese: "1小时10 EMA下穿30 EMA做空，反向上穿平仓，风险1%，止损4%", english: "On 1h bars, short when EMA 10 crosses below EMA 30 and close on an upward cross; risk 1% with a 4% stop.",
    declarations: 'const fast = ctx.indicators.ema("close", 10);\nconst fastPrevious = ctx.indicators.ema("close", 10, 1);\nconst slow = ctx.indicators.ema("close", 30);\nconst slowPrevious = ctx.indicators.ema("close", 30, 1);',
    entry: [emaCross(10, 30, "Below")], exit: [emaCross(10, 30, "Above")],
  }),
  golden({
    id: "sma-10-30-long", title: "SMA 10/30 Long Crossover", timeframe: "1h", side: "long",
    chinese: "1小时10周期简单均线上穿30周期简单均线做多，死叉退出", english: "Go long on the 1h SMA 10/30 bullish crossover and exit on the bearish crossover.",
    declarations: 'const fast = ctx.indicators.sma("close", 10);\nconst fastPrevious = ctx.indicators.sma("close", 10, 1);\nconst slow = ctx.indicators.sma("close", 30);\nconst slowPrevious = ctx.indicators.sma("close", 30, 1);',
    entry: [smaCross(10, 30, "Above")], exit: [smaCross(10, 30, "Below")],
  }),
  golden({
    id: "hourly-ema-from-15m", title: "15m With Closed 1h EMA", timeframe: "15m", side: "long",
    chinese: "每15分钟检查一次，只用已经收盘的1小时K线；1小时20 EMA上穿50 EMA做多，死叉退出", english: "Evaluate every 15 minutes using only closed 1h bars; go long on the 1h EMA 20/50 bullish cross and exit on the reverse cross.",
    declarations: 'const hourly = ctx.timeframe("1h");\nif (hourly === null) return { type: "hold" };\nconst fast = hourly.indicators.ema("close", 20);\nconst fastPrevious = hourly.indicators.ema("close", 20, 1);\nconst slow = hourly.indicators.ema("close", 50);\nconst slowPrevious = hourly.indicators.ema("close", 50, 1);',
    entry: [{ source: "ctx.crossedAbove(fast, fastPrevious, slow, slowPrevious)", contract: 'crossAbove(timeframe("1h").ema("close",20,0),timeframe("1h").ema("close",20,1),timeframe("1h").ema("close",50,0),timeframe("1h").ema("close",50,1))' }],
    exit: [{ source: "ctx.crossedBelow(fast, fastPrevious, slow, slowPrevious)", contract: 'crossBelow(timeframe("1h").ema("close",20,0),timeframe("1h").ema("close",20,1),timeframe("1h").ema("close",50,0),timeframe("1h").ema("close",50,1))' }],
  }),
  golden({
    id: "ema-funding-long", title: "EMA Long With Negative Funding", timeframe: "4h", side: "long",
    chinese: "4小时20/50 EMA金叉且资金费率为负时做多，死叉退出", english: "On 4h bars, go long only when EMA 20 crosses above EMA 50 and funding is negative; exit on the reverse cross.",
    declarations: 'const fast = ctx.indicators.ema("close", 20);\nconst fastPrevious = ctx.indicators.ema("close", 20, 1);\nconst slow = ctx.indicators.ema("close", 50);\nconst slowPrevious = ctx.indicators.ema("close", 50, 1);',
    entry: [emaCross(20, 50, "Above"), { source: "ctx.market.fundingRate < 0", contract: "market.fundingRate < 0" }], exit: [emaCross(20, 50, "Below")],
  }),
  golden({
    id: "ema-funding-short", title: "EMA Short With Positive Funding", timeframe: "4h", side: "short",
    chinese: "4小时20/50 EMA死叉且资金费率为正时做空，金叉退出", english: "On 4h bars, short only when EMA 20 crosses below EMA 50 and funding is positive; exit on the bullish cross.",
    declarations: 'const fast = ctx.indicators.ema("close", 20);\nconst fastPrevious = ctx.indicators.ema("close", 20, 1);\nconst slow = ctx.indicators.ema("close", 50);\nconst slowPrevious = ctx.indicators.ema("close", 50, 1);',
    entry: [emaCross(20, 50, "Below"), { source: "ctx.market.fundingRate > 0", contract: "market.fundingRate > 0" }], exit: [emaCross(20, 50, "Above")],
  }),
  golden({
    id: "price-ema-long", title: "Price Above EMA 50", timeframe: "4h", side: "long",
    chinese: "4小时收盘价高于50 EMA时做多，跌回50 EMA下方平仓", english: "On 4h bars, go long while close is above EMA 50 and close when it falls below EMA 50.",
    declarations: 'const baseline = ctx.indicators.ema("close", 50);\nif (baseline === null) return { type: "hold" };',
    entry: [{ source: "ctx.market.close > baseline", contract: 'market.close > ema("close",50,0)' }],
    exit: [{ source: "ctx.market.close < baseline", contract: 'market.close < ema("close",50,0)' }],
  }),
  golden({
    id: "price-sma-short", title: "Price Below SMA 100", timeframe: "4h", side: "short",
    chinese: "4小时收盘价低于100 SMA时做空，收盘价高于均线时平仓；这是当前值条件，不要求发生上穿", english: "On 4h bars, short while close is below SMA 100 and close while the current close is above it; these are level conditions, not crossing events.",
    declarations: 'const baseline = ctx.indicators.sma("close", 100);\nif (baseline === null) return { type: "hold" };',
    entry: [{ source: "ctx.market.close < baseline", contract: 'market.close < sma("close",100,0)' }],
    exit: [{ source: "ctx.market.close > baseline", contract: 'market.close > sma("close",100,0)' }],
  }),
  golden({
    id: "donchian-long", title: "Donchian Long Breakout", timeframe: "4h", side: "long", takeProfitRiskReward: 2,
    chinese: "4小时收盘价高于前20根K线的最高high字段时做多，收盘价低于前10根K线的最低low字段时退出，止盈风险收益比2", english: "On 4h bars, go long when the close is above the highest OHLC high field of the prior 20 bars and exit when the close is below the lowest OHLC low field of the prior 10 bars, with 2R take profit.",
    declarations: 'const upper = ctx.indicators.highest("high", 20, 1);\nconst lower = ctx.indicators.lowest("low", 10, 1);\nif (upper === null || lower === null) return { type: "hold" };',
    entry: [{ source: "ctx.market.close > upper", contract: 'market.close > highest("high",20,1)' }],
    exit: [{ source: "ctx.market.close < lower", contract: 'market.close < lowest("low",10,1)' }],
  }),
  golden({
    id: "donchian-short", title: "Donchian Short Breakout", timeframe: "4h", side: "short", takeProfitRiskReward: 2,
    chinese: "4小时收盘价低于前20根最低价做空，收盘价高于前10根最高价退出", english: "On 4h bars, short when the close is below the prior 20-bar low and exit when the close is above the prior 10-bar high.",
    declarations: 'const lower = ctx.indicators.lowest("low", 20, 1);\nconst upper = ctx.indicators.highest("high", 10, 1);\nif (upper === null || lower === null) return { type: "hold" };',
    entry: [{ source: "ctx.market.close < lower", contract: 'market.close < lowest("low",20,1)' }],
    exit: [{ source: "ctx.market.close > upper", contract: 'market.close > highest("high",10,1)' }],
  }),
  golden({
    id: "momentum-long", title: "20-Bar Momentum Long", timeframe: "1h", side: "long",
    chinese: "1小时20周期涨幅超过5%做多，动量回到0以下退出", english: "On 1h bars, go long when 20-bar return exceeds 5% and exit when it falls below zero.",
    declarations: 'const momentum = ctx.indicators.percentChange("close", 20);\nif (momentum === null) return { type: "hold" };',
    entry: [{ source: "momentum > 0.05", contract: 'percentChange("close",20) > 0.05' }],
    exit: [{ source: "momentum < 0", contract: 'percentChange("close",20) < 0' }],
  }),
  golden({
    id: "momentum-short", title: "20-Bar Momentum Short", timeframe: "1h", side: "short",
    chinese: "1小时20周期收益率低于-5%做空，20周期收益率回到0以上退出", english: "On 1h bars, short when 20-bar return is below -5% and exit when the same 20-bar return rises above zero.",
    declarations: 'const momentum = ctx.indicators.percentChange("close", 20);\nif (momentum === null) return { type: "hold" };',
    entry: [{ source: "momentum < -0.05", contract: 'percentChange("close",20) < -0.05' }],
    exit: [{ source: "momentum > 0", contract: 'percentChange("close",20) > 0' }],
  }),
  golden({
    id: "mean-reversion-long", title: "Dip Mean Reversion Long", timeframe: "1h", side: "long",
    chinese: "1小时10周期收益率低于-5%后做多，10周期收益率回到0或以上时退出", english: "On 1h bars, buy when the 10-bar return is below -5% and exit when that return reaches zero or above.",
    declarations: 'const change = ctx.indicators.percentChange("close", 10);\nif (change === null) return { type: "hold" };',
    entry: [{ source: "change < -0.05", contract: 'percentChange("close",10) < -0.05' }],
    exit: [{ source: "change >= 0", contract: 'percentChange("close",10) >= 0' }],
  }),
  golden({
    id: "mean-reversion-short", title: "Spike Mean Reversion Short", timeframe: "1h", side: "short",
    chinese: "1小时10周期收益率高于5%后做空，10周期收益率回落到0或以下时退出", english: "On 1h bars, short when the 10-bar return is above 5% and exit when that return reaches zero or below.",
    declarations: 'const change = ctx.indicators.percentChange("close", 10);\nif (change === null) return { type: "hold" };',
    entry: [{ source: "change > 0.05", contract: 'percentChange("close",10) > 0.05' }],
    exit: [{ source: "change <= 0", contract: 'percentChange("close",10) <= 0' }],
  }),
  golden({
    id: "rsi-long", title: "RSI Oversold Long", timeframe: "1h", side: "long",
    chinese: "1小时RSI14低于30做多，RSI回到50以上退出", english: "On 1h bars, go long when RSI 14 is below 30 and exit above 50.",
    declarations: 'const rsi = ctx.indicators.rsi("close", 14);\nif (rsi === null) return { type: "hold" };',
    entry: [{ source: "rsi < 30", contract: 'rsi("close",14,0) < 30' }],
    exit: [{ source: "rsi > 50", contract: 'rsi("close",14,0) > 50' }],
  }),
  golden({
    id: "rsi-short", title: "RSI Overbought Short", timeframe: "1h", side: "short",
    chinese: "1小时RSI14高于70做空，RSI跌回50以下退出", english: "On 1h bars, short when RSI 14 is above 70 and exit below 50.",
    declarations: 'const rsi = ctx.indicators.rsi("close", 14);\nif (rsi === null) return { type: "hold" };',
    entry: [{ source: "rsi > 70", contract: 'rsi("close",14,0) > 70' }],
    exit: [{ source: "rsi < 50", contract: 'rsi("close",14,0) < 50' }],
  }),
  golden({
    id: "bollinger-long", title: "Bollinger Lower-Band Long", timeframe: "1h", side: "long",
    chinese: "1小时收盘价低于20周期2倍标准差布林下轨做多，收盘价回到中轨或以上退出", english: "On 1h bars, go long when the close is below the 20-period 2-sigma lower Bollinger band and exit when the close is at or above the middle band.",
    declarations: 'const bands = ctx.indicators.bollingerBands("close", 20, 2);\nif (bands === null) return { type: "hold" };',
    entry: [{ source: "ctx.market.close < bands.lower", contract: 'market.close < bollingerBands("close",20,2,0).lower' }],
    exit: [{ source: "ctx.market.close >= bands.middle", contract: 'market.close >= bollingerBands("close",20,2,0).middle' }],
  }),
  golden({
    id: "bollinger-short", title: "Bollinger Upper-Band Short", timeframe: "1h", side: "short",
    chinese: "1小时收盘价高于20周期2倍标准差布林上轨做空，收盘价回到中轨或以下退出", english: "On 1h bars, short when the close is above the 20-period 2-sigma upper Bollinger band and exit when the close is at or below the middle band.",
    declarations: 'const bands = ctx.indicators.bollingerBands("close", 20, 2);\nif (bands === null) return { type: "hold" };',
    entry: [{ source: "ctx.market.close > bands.upper", contract: 'market.close > bollingerBands("close",20,2,0).upper' }],
    exit: [{ source: "ctx.market.close <= bands.middle", contract: 'market.close <= bollingerBands("close",20,2,0).middle' }],
  }),
  golden({
    id: "macd-long", title: "MACD Histogram Long", timeframe: "4h", side: "long",
    chinese: "4小时MACD(12,26,9)柱线大于0做多，小于0退出", english: "On 4h bars, go long when the MACD 12/26/9 histogram is above zero and exit when it is below zero.",
    declarations: 'const macd = ctx.indicators.macd("close", 12, 26, 9);\nif (macd === null) return { type: "hold" };',
    entry: [{ source: "macd.histogram > 0", contract: 'macd("close",12,26,9,0).histogram > 0' }],
    exit: [{ source: "macd.histogram < 0", contract: 'macd("close",12,26,9,0).histogram < 0' }],
  }),
  golden({
    id: "atr-ema-long", title: "ATR-Filtered EMA Long", timeframe: "4h", side: "long",
    chinese: "4小时20/50 EMA金叉且ATR14大于100时做多，死叉退出", english: "On 4h bars, go long on an EMA 20/50 bullish cross only when ATR 14 exceeds 100; exit on the reverse cross.",
    declarations: 'const fast = ctx.indicators.ema("close", 20);\nconst fastPrevious = ctx.indicators.ema("close", 20, 1);\nconst slow = ctx.indicators.ema("close", 50);\nconst slowPrevious = ctx.indicators.ema("close", 50, 1);\nconst atr = ctx.indicators.atr(14);\nif (atr === null) return { type: "hold" };',
    entry: [emaCross(20, 50, "Above"), { source: "atr > 100", contract: "atr(14,0) > 100" }],
    exit: [emaCross(20, 50, "Below")],
  }),
];

export const GOLDEN_INTENT_COUNT = GOLDEN_STRATEGY_CASES.reduce((sum, item) => sum + item.intents.length, 0);

if (GOLDEN_STRATEGY_CASES.length !== 20 || GOLDEN_INTENT_COUNT !== 100) {
  throw new Error(`Golden corpus must contain exactly 20 strategies and 100 intents; received ${GOLDEN_STRATEGY_CASES.length}/${GOLDEN_INTENT_COUNT}.`);
}
