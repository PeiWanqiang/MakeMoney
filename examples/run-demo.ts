import { runBacktest } from "../src/index.js";
import { thresholdStrategy } from "./strategies.js";

const closes = [98, 99, 101, 102, 106, 107, 105, 103];
const bars = closes.map((close, index) => ({
  timestamp: Date.UTC(2026, 0, 1, index),
  open: index === 0 ? close : (closes[index - 1] ?? close),
  high: close + 0.5,
  low: close - 0.5,
  close,
  volume: 1000 + index * 10,
  markPrice: close,
  fundingRate: 0,
  openInterest: 1_000_000 + index * 10_000,
}));

const result = await runBacktest(thresholdStrategy, bars, {
  initialCapital: 10_000,
  takerFeeRate: 0.00045,
  slippageBps: 0,
  maxLeverage: 3,
});

console.log(JSON.stringify(result, null, 2));

