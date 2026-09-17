# The BTC one-minute historical market data pipeline

English | [简体中文](DATA_PIPELINE.zh-CN.md)

Status: Implemented v0.1

## Conclusion

Only 1m candles are stored at the base layer. 15m, 1h, and 4h are all
deterministically aggregated from the same 1m snapshot. Silently mixing
timeframe candles from different vendors or different venues is forbidden.

For a decade of BTC spot research data, the authoritative series is Kraken
`XBTUSD`. Kraken officially publishes complete OHLCVT ZIPs covering each market
from its start to the present, with quarterly increments; its BTC/USD market
covers 2016–2026. For fast development and year-by-year verification we use the
Binance Vision `BTCUSDT` monthly packages, because they are distributed per
month, ship a SHA-256 per file, and download quickly.

The two series cannot be concatenated automatically: `XBTUSD` and `BTCUSDT`, and
Kraken and Binance, differ in basis and in microstructure. The data catalog
always keeps `source`, `venue`, and `instrument`, and a backtest must choose its
dataset explicitly.

Official references:

- [Kraken downloadable OHLCVT historical data](https://support.kraken.com/articles/360047124832-downloadable-historical-ohlcvt-open-high-low-close-volume-trades-data)
- [Binance Public Data, including how to verify](https://github.com/binance/binance-public-data)
- [Coinbase Exchange candles API, as a fallback](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles)

## Implemented

- Streaming reads from the official ZIPs, so a decade of CSV is never loaded
  into memory at once.
- Monthly Parquet partitions, so one corrupt partition does not destroy the
  whole ten-year dataset.
- Verification against Binance's official `.CHECKSUM` SHA-256 files.
- A SHA-256 for each Parquet file, a partition manifest, and a global dataset
  catalog.
- `.part` download files and HTTP Range resumption.
- Existing partitions are hash-verified first, then skipped, on a re-run.
- Millisecond and microsecond timestamps are both accepted and normalized to UTC
  epoch milliseconds.
- Detection of duplicates, invalid OHLC, and minute gaps.
- Incomplete aggregation buckets never enter a 15m/1h/4h backtest.

## Local verification results

A full year of Binance Spot `BTCUSDT` for 2024 has been run end to end locally:

| Item | Result |
|---|---:|
| 1m rows | 527,040 |
| Theoretical minutes | 527,040 |
| Missing minutes | 0 |
| Parquet partitions | 12 |
| Complete 1h buckets | 8,784 |
| Incomplete 1h buckets | 0 |
| ZIP cache size | 31 MB |
| Parquet + manifest size | 19 MB |

Local data lives in `data/`, which is in `.gitignore` and never committed.

### Multi-year BTCUSDT perpetual data

The Binance USD-M `BTCUSDT` perpetual has been fully backfilled month by month
from 2020-01-01 to 2026-07-01 (end-exclusive):

| Item | Result |
|---|---:|
| Coverage | 2020-01-01 to 2026-06-30 |
| 1m traded candles | 3,417,120 |
| Theoretical minutes | 3,417,120 |
| Missing traded candles | 0 |
| Funding events | 7,119 |
| Monthly Parquet partitions | 78 |
| Missing mark prices | 13,015 (about 0.38%) |
| ZIP cache | about 232 MB |
| Parquet + manifest | about 140 MB |

The missing mark prices are concentrated in 8 months. The manifest records
`missingMarkPrices` per month, and Parquet falls back to the traded close for
those minutes. A backtest report must disclose that substitution and must never
describe a fallback value as the exchange's original mark price.

The monthly fact set only goes up to the last complete UTC month; the current
month's daily packages and live tail are not merged yet. The official long-term
open-interest archive starts much later and is mostly 5m daily packages, so it is
not part of this v0.1 dataset.

## Usage

### One year, for a quick check

```bash
npm run data:binance-history -- \
  --symbol BTCUSDT \
  --start 2024-01-01T00:00:00Z \
  --end 2025-01-01T00:00:00Z
```

`--end` is exclusive. The output directory defaults to
`data/history/binance-spot/BTCUSDT/1m`.

### A decade from a single exchange

```bash
npm run data:kraken-history -- \
  --pair XBTUSD \
  --start 2016-01-01T00:00:00Z \
  --end 2026-01-01T00:00:00Z
```

By default the tool tries to resume the full ZIP linked from Kraken's official
page. If Google Drive demands interactive confirmation, download it by hand from
that page first, then run:

```bash
npm run data:kraken-history -- \
  --archive /absolute/path/Kraken_OHLCVT.zip \
  --pair XBTUSD \
  --start 2016-01-01T00:00:00Z \
  --end 2026-01-01T00:00:00Z
```

Kraken states explicitly that minutes without trades do not appear in the CSV. We
preserve that fact and do not fabricate candles by default. The catalog's
`observedMissingMinutes` reflects the unobserved minutes. A research task that
needs a continuous time grid should choose "forward-fill with zero volume"
explicitly in a derived layer, and write that transformation into the backtest
manifest.

### Multi-year perpetual data

```bash
npm run data:binance-perp-history -- \
  --symbol BTCUSDT \
  --start 2020-01-01T00:00:00Z \
  --end 2026-07-01T00:00:00Z
```

Each month downloads and verifies three things: traded `klines`,
`markPriceKlines`, and `fundingRate`. Funding is written only at the minutes
where it actually settled, with millisecond offsets floored into the containing
minute. The output directory defaults to
`data/history/binance-usdm/BTCUSDT-PERP/1m`.

### Backtesting

```bash
npm run backtest:real -- \
  data/history/binance-spot/BTCUSDT/1m/dataset.catalog.json 4h
```

The default `trend` example is an EMA trend engineering baseline that does not
depend on funding; it produces real trades on the 2024 spot data and writes a
full JSON report. You can also pass `funding` at the end of the command to run
the funding strategy — but the two ten-year Binance/Kraken datasets are spot, so
funding is 0 and the funding strategy may not trade at all. Long-horizon
perpetual research still needs its own contract candles, funding, mark prices,
and contract-rollover information.

## Evolving toward production

The local Parquet files are the source of truth for backtests. In production,
the same partitions and manifests are uploaded to object storage, with ClickHouse
only as a query accelerator. Daily incremental collection keeps writing new
immutable partitions; overwriting a historical file is forbidden. When a vendor
revises data, that produces a new snapshot ID, and old backtests stay
reproducible.
