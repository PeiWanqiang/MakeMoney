# Classic strategy prompts for a demo

English | [简体中文](DEMO_STRATEGIES.zh-CN.md)

Purpose: paste these one at a time into "Step 1 · Describe your strategy" in the
web app to walk through the full four-step flow (describe → confirm → backtest →
optimize).

> The prompts below are English translations. The exact strings that have
> actually been exercised are the Chinese originals in
> [the Chinese version](DEMO_STRATEGIES.zh-CN.md); the engine accepts either
> language, but only the Chinese ones have been run as written.

Every prompt spells out the five things the `ready` bar requires — **timeframe,
entry condition, direction, position size, stop loss** — plus one explicit exit
condition. Drop any of them and the model goes to `needs_clarification`.

Capability boundary (do not write past it): indicators are only SMA / EMA / RSI /
MACD / ATR / Bollinger Bands / highest-lowest over N bars / percentage change,
plus bounded arithmetic. Timeframes are only 1m / 15m / 1h / 4h / 1d / 1w (daily
and weekly open in UTC, weekly starts on Monday). Position sizing is only a fixed
amount, a percentage of equity, or a percentage of risk. Stop loss is only a
percentage. Take profit is only a reward-to-risk multiple.

Data availability: **BTCUSDT perpetual 15m/1h/4h (2020-01 to 2026-07)** is cached
locally. ETHUSDT and SOLUSDT are fetched remotely and are noticeably slower. The
suggested ranges below all assume BTCUSDT on Binance Perpetual.

One backtest is capped at 10,000 candles, which works out to about 400 days on
1h, about 4.5 years on 4h, and about 100 days on 15m. **Do not pick the "last 3
years" preset on the 1h timeframe; it exceeds the cap immediately.**

---

## 1. Trend following

### 1. EMA golden cross / death cross (the classic one)

```
On the 1h timeframe, go long BTC when the 20-period EMA crosses above the 50-period EMA and the position is flat, risking 1% of account equity per trade with a 5% stop loss; close the position when the 20-period EMA crosses below the 50-period EMA.
```

- Suggested: BTCUSDT / Binance Perpetual / last 1 year
- What to watch: `crossAbove` is a real "crossing event", not "greater than". The
  confirmation page should say "crosses above", not "is above".

### 2. Donchian channel breakout (a simplified Turtle rule)

```
On the 4h timeframe, buy to open a long when the close is above the highest high of the previous 20 candles and the position is flat, sizing at 20% of account equity with an 8% stop loss; close when the close falls below the lowest low of the previous 10 candles.
```

- Suggested: BTCUSDT / Binance Perpetual / last 3 years
- What to watch: the lag in `highest("high",20,1)` must be 1 (excluding the
  current candle), or it can never break out past itself. The confirmation page
  is only right if it says "the highest high of the last 20 candles (offset by
  1)".

### 3. MACD histogram turning positive

```
On the 4h timeframe, go long when the MACD(12,26,9) histogram turns from negative to positive and the position is flat, using a fixed 2000 USDT position each time, with a 6% stop loss and 12% take profit; close when the histogram turns negative.
```

- Suggested: BTCUSDT / Binance Perpetual / last 3 years
- What to watch: 12% take profit against a 6% stop should be converted to
  `takeProfitRiskReward = 2`. Also check whether "turns from negative to
  positive" is correctly written as a `crossAbove(...histogram..., 0, 0)` shape.

### 4. Holding with the trend above a moving average

```
On the 1h timeframe, go long BTC when the close is above the 200-period EMA, RSI(14) is above 55, and the position is flat, losing at most 1.5% of the account per trade with a 4% stop loss; close when the close breaks below the 200-period EMA.
```

- Suggested: BTCUSDT / Binance Perpetual / last 1 year
- What to watch: a 200-period EMA needs a long warm-up; check that the backtest
  start is pushed back correctly.

---

## 2. Mean reversion

### 5. Buying an RSI oversold dip (4h version)

```
On the 4h timeframe, go long BTC when RSI(14) is below 25 and the position is flat, opening with 30% of account equity, a 7% stop loss and 14% take profit; close when RSI rises above 60.
```

- Suggested: BTCUSDT / Binance Perpetual / last 3 years
- What to watch: compare against the 1h version on the home page — same logic,
  different timeframe, and see how win rate and drawdown move.

### 6. Bouncing off the lower Bollinger band

```
On the 1h timeframe, buy to open a long when the close is below the lower Bollinger band (20-period, 2 standard deviations) and the position is flat, risking 1% per trade with a 5% stop loss; close when the close returns above the middle band.
```

- Suggested: BTCUSDT / Binance Perpetual / last 1 year
- What to watch: the confirmation page names all three bands; check that upper,
  middle, and lower are not swapped.

### 7. Buying after a sustained fall

```
On the 15m timeframe, go long BTC when the close has fallen more than 5% over the last 20 candles and the position is flat, opening with 25% of account equity, a 3% stop loss and 6% take profit; close when the last 10 candles have risen more than 3%.
```

- Suggested: BTCUSDT / Binance Perpetual / last 2 months
- What to watch: the sign convention of `percentChange` — "fallen more than 5%"
  must be `< -0.05`.

---

## 3. Breakout and momentum

### 8. Breaking out through the upper Bollinger band

```
On the 1h timeframe, go long when the close crosses above the upper Bollinger band (20-period, 2 standard deviations) and the position is flat, opening with 20% of account equity, a 4% stop loss and 8% take profit; close when the close falls back below the middle band.
```

- Suggested: BTCUSDT / Binance Perpetual / last 1 year
- What to watch: this is the mirror use of the indicator in #6, so running them
  together shows which direction of the same indicator holds up better.

### 9. Momentum on a 20-bar high

```
On the 15m timeframe, buy to open a long in BTC when the close makes a new high above the previous 20 candles and the position is flat, risking 1% of the account per trade, with a 2.5% stop loss and 5% take profit; while in position, close if the close falls below the lowest low of the previous 10 candles.
```

- Suggested: BTCUSDT / Binance Perpetual / last 2 months
- What to watch: a short-timeframe, high-frequency signal, so trade count rises
  sharply — a good way to see how much fees and slippage eat.

### 10. Medium-term momentum

```
On the 4h timeframe, go long BTC when the close has risen more than 8% over the last 18 candles and the position is flat, opening with 25% of account equity and a 10% stop loss; close when the 18-candle change falls back below 0.
```

- Suggested: BTCUSDT / Binance Perpetual / last 3 years
- What to watch: a textbook "chase the rally" strategy — watch it get slapped
  repeatedly in a down year like 2022.

---

## 4. Shorts and both directions

### 11. Shorting RSI overbought

```
On the 1h timeframe, go short BTC when RSI(14) is above 75 and the position is flat, risking 1% of the account per trade, with a 4% stop loss and 8% take profit; close when RSI falls below 50.
```

- Suggested: BTCUSDT / Binance Perpetual / last 1 year
- What to watch: the only pure short sample — use it to verify that PnL sign,
  liquidation, and leverage constraints are not inverted for shorts.

### 12. Shorting the death cross

```
On the 4h timeframe, sell to open a short in BTC when the 20-period EMA crosses below the 60-period EMA and the position is flat, opening with 20% of account equity and a 6% stop loss; close when the 20-period EMA crosses back above the 60-period EMA.
```

- Suggested: BTCUSDT / Binance Perpetual / last 3 years
- What to watch: the exact mirror of #1. Running both shows the long/short
  asymmetry of recent years directly.

---

## 5. Multi-timeframe confluence

### 13. Higher timeframe sets direction, lower timeframe finds the entry

```
On the 1h timeframe, go long BTC when the 4h close is above the 4h 50-period EMA, the 1h RSI(14) is below 40, and the position is flat, risking 1% per trade with a 4% stop loss and 8% take profit; close when the 1h RSI rises above 65 or the close breaks below the 1h 50-period EMA.
```

- Suggested: BTCUSDT / Binance Perpetual / last 1 year
- What to watch: this one uses the `timeframe("4h").` prefix, the easiest place
  in the whole syntax to leak future data — check specifically that no fill
  timestamp in the backtest precedes the close of its 4h candle.

---

## 6. Deliberately out-of-bounds samples (testing honesty at the boundary)

These are not for making money. They are for checking whether the product
hard-codes anything, or fobs you off with a similar-looking indicator.

### B1. Missing conditions → should ask

```
Get into BTC when it breaks out, get out when it weakens, don't size too heavy, look at the hourly chart.
```

Expected: `needs_clarification`, asking point by point what "breaks out" breaks
below, what the position size actually is, and where the stop goes.

### B2. ATR stop → indicator supported, this stop form is not

```
On the 4h timeframe, go long BTC when the close is above the highest high of the previous 20 candles, risking 1% per trade, with the stop placed 2x ATR(14) below the entry price; close when the close falls below the lowest low of the previous 10 candles.
```

Expected: either state that stops only support percentages (`unsupported`, or
explain the conversion in `assumptions`). It must **not** quietly substitute a
percentage number without telling you. This is the original Turtle stop, and the
single most worthwhile case to watch.

### B3. Funding rate → a known inconsistency

```
On the 1h timeframe, go long BTC when the funding rate is negative, the 20-period EMA crosses above the 50-period EMA, and the position is flat, risking 1% per trade with a 5% stop loss; close on the cross below.
```

Expected: today step 2 will most likely call this `ready` (the analyze-side
capability list includes funding rate), but step 3 fails outright with "the
current web backtest data only contains OHLCV". See
[web/worker/backtest-api.ts:918](../web/worker/backtest-api.ts#L918). **This is a
mismatch between the analyze-side and backtest-side capability lists — a product
defect, not a badly written strategy.**

### B4. Requires non-market data → should say plainly that it cannot

```
On the 1h timeframe, go long when BTC discussion volume on Twitter enters the top 10% and order-book bid depth is more than twice the ask depth, risking 1% per trade with a 5% stop loss; close when the discussion volume falls back.
```

Expected: `unsupported`, explicitly listing sentiment data and order-book depth as
what is missing, rather than substituting volume as a stand-in.

---

## Suggested demo order

1. Run **#1** (the dual moving average) first to get through the whole flow and
   see what the four steps look like.
2. Then run **#6 and #8** (Bollinger reversion versus breakout) to see two uses
   of one indicator side by side.
3. Run **#13** (multi-timeframe), the syntax path most likely to go wrong.
4. Finally run **B1 through B4** in order — those four are what actually test the
   honesty the product is sold on.
5. Take one with many trades (**#9**) into step 4 auto-optimization and check
   whether the validation segment really improves after tuning.
