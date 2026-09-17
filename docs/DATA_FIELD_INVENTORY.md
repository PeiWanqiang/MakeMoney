# Market-data fields available to strategy indicators

English | [简体中文](DATA_FIELD_INVENTORY.zh-CN.md)

Status: Inventory v0.1 (2026-08-04, checked against `src/data/` and
`web/worker/backtest-api.ts`)

Goal: give strategy indicators the most complete base market data we can, and
state clearly which fields are *already stored*, which are *present in the
source but currently discarded*, and which are *structurally unavailable*.

## 1. Already stored (in the `data/history/` pipeline)

| Field | Binance Spot BTCUSDT 2024 | Binance USD-M BTCUSDT-PERP 2020–2026 | Kraken XBTUSD 2016–2026 | Hyperliquid, recent |
|---|---|---|---|---|
| Open / High / Low / Close | ✓ | ✓ | ✓ (code ready, ZIP path not yet working) | ✓ |
| Volume (base) | ✓ | ✓ | ✓ | ✓ |
| Trades (count) | ✓ (Binance column 8) | ✓ | ✓ (the T in OHLCVT) | ✓ (candle `n`) |
| Funding rate | — (always 0 for spot) | ✓ (7,119 events, by settlement minute) | — | ✓ (hourly events, summed per bar) |
| Funding premium | — | — | — | ✓ |
| Mark price | — | ✓ (0.38% missing, concentrated in 8 months; falls back to the traded close, and discloses it) | — | — |

Data quality: minute-gap detection, duplicate and invalid-OHLC detection,
exclusion of incomplete aggregation buckets from backtests, and SHA-256 plus a
catalog manifest are all implemented.

## 2. Present in the source but previously discarded (free to add; done 2026-08-04)

Binance kline archives and endpoints have 12 columns. `parseBinanceKline`
(`src/data/historical-dataset.ts`) previously read only 0–5 and 8. The same ZIP,
for both the spot and USD-M monthly packages, **also contains**:

| Column | Field | Meaning | Status |
|---|---|---|---|
| 7 | `quote_asset_volume` | Turnover in quote currency (**the denominator any turnover-rate metric needs**) | ✓ stored |
| 8 | `number_of_trades` | Trade count | ✓ stored (already was) |
| 9 | `taker_buy_base_volume` | Aggressive buy volume (base) | ✓ stored |
| 10 | `taker_buy_quote_volume` | Aggressive buy turnover (quote) | ✓ stored |

**Where this landed (2026-08-04):**

- `MarketBar` gained `quoteVolume?`, `takerBuyBaseVolume?`, and
  `takerBuyQuoteVolume?` (`src/core/types.ts`).
- `parseBinanceKline` now also reads columns 7, 9, and 10
  (`src/data/historical-dataset.ts`).
- Parquet snapshots write and read back the three columns when present; older
  partitions without them still load (`src/data/market-snapshot.ts`).
- Aggregation to 15m/1h/4h sums them through (`src/data/aggregate-bars.ts`).
- The SDK, sandbox, compiler declarations, and prompt expose
  `market.quoteVolume`, `market.takerBuyBaseVolume`, and
  `market.takerBuyQuoteVolume` (reachable through both `market.*` and
  `history.*`, `null` when not provided), and they can be passed as the field
  argument to `sma`, `ema`, `highest`, `lowest`, `standardDeviation`,
  `bollingerBands`, and `percentChange`.
- Tests cover parsing, snapshot round-trip, and aggregation summing
  (`test/historical-data.test.ts`).

Existing ZIPs only need to be re-parsed; the download cache is still in
`data/cache/`, so nothing has to be downloaded again. The fields are optional:
non-Binance sources (Kraken, Hyperliquid) do not carry them, and a strategy
reads `null`.

On the web side, `parseKlineRows` (`web/worker/backtest-api.ts:781`) still reads
only the first 6 columns. Data ownership moves into the service in Phase 5, which
will cover this, so it does not need a separate fix. Note that **until the web
engine is replaced under Path A, a web backtest cannot interpret conditions on
`market.quoteVolume` and the other new fields** — it rejects them as
uninterpretable. The CLI and the sandbox support them fully.

## 3. Structurally unavailable or source-limited

| Field | Conclusion | Reason |
|---|---|---|
| Open interest, 1m, full history | **Unavailable** | The official Binance USD-M long-term archive starts around 2021 and ships **5m daily packages**; REST `openInterestHist` returns only 30 days per call. Nothing at 1m for 2020 or earlier. Hyperliquid exposes only a current OI snapshot (`metaAndAssetCtxs`), with no history. |
| Mark price with no gaps | **Unavailable** | Eight months have 0.38% missing. The only option is the traded-close fallback plus disclosure; the original values cannot be recovered. |
| Turnover rate (against float) | **No such raw field** | Crypto perpetuals have no authoritative free-float measure; exchanges provide only `quote_asset_volume`. A "turnover rate" can only be derived (for example `quoteVolume / N-day average`), which makes it a derived indicator. |
| L2 depth / order-book history | **Unavailable** | Spot has no long-term archive; the USD-M `bookDepth` snapshot files are enormous and cover little, and cannot support 1m from 2020 onward. |
| Liquidation event history | **Unavailable** | Exchanges offer only a live WebSocket feed, with no archive. |
| Tick-by-tick trades from 2020 | **Unavailable / impractical** | Archive coverage is incomplete and the volume is unmanageable; a bar-level engine does not need it. |
| Long/short position and account ratios | **Limited** | Binance REST covers only the top-trader definition, 30 days per call. Backfilling is heavy and still incomplete. |

> Note: the Kraken decade and the long Hyperliquid history are "the source
> exists but is not yet wired up locally", not "unavailable". See §4.

## 4. Obtainable, but needs new download work (schedule as needed)

| Field | Source | Work |
|---|---|---|
| Index / oracle price | Binance USD-M `indexPriceKlines` REST (same shape as the `markPriceKlines` feed already wired up); Hyperliquid oracle through its API | New download script plus gap handling |
| Open interest 5m (part of 2021+) | Backfill `openInterestHist` month by month | Many requests, plus a 5m→1m alignment policy |
| Full Hyperliquid history | The official Hyperliquid S3 data bucket | New connector plus a size assessment |
| Aggressive buy/sell ratio metrics | The taker-buy fields from §2 | Comes with §2, no extra source |

## 5. Suggested priority

1. **Immediately (half a day)**: store the four fields in §2 — they come free
   from the same ZIP and directly unlock turnover and aggressive buy/sell
   indicators.
2. **Together with Path A**: move data ownership into the backtest service, with
   one field schema in `src/contracts/`, so the web side stops keeping its own.
3. **Schedule against product need**: index price, 5m open interest, and the full
   Hyperliquid history (§4).
4. **Explicitly not doing**: L2 history, liquidation history, and full
   tick-by-tick history (§3), unless product validation clearly demands them.
