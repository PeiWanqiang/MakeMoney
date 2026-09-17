# Independent cross-validation of the backtest engine

English | [简体中文](CROSS_VALIDATION.zh-CN.md)

Status: Implemented v0.1  
Reference engine: Python stdlib-only `python-reference-0.1.0`  
Primary engine: TypeScript/QuickJS `0.2.0`

## Goal

Determinism only proves that one implementation repeats itself; it does not
prove the implementation is correct. The project therefore maintains a second
engine, written in Python, that imports nothing from the TypeScript runtime and
independently implements:

- EMA seeding and recursion.
- Cross above / cross below.
- Bar-close signals with next-bar-open fills.
- Long/short direction and risk-based position sizing.
- Taker fees and fixed-bps slippage.
- Funding direction, mark-price notional, and accumulation.
- Stop loss, take profit, signal exits, and end-of-period liquidation.
- Stop-loss priority when a stop and a target collide on the same bar.

The comparator checks every trade field by field — direction, entry and exit
time, fill price, size, gross PnL, funding, fees, slippage, net PnL, and exit
reason — and checks the equity curve point by point. Default tolerances are
`1e-8` absolute and `1e-10` relative; any excess produces a failure report and
makes the command exit non-zero.

## Completed runs

Dataset: `binance-usdm-btcusdt-perp-1m-2020-01-2026-06`  
Timeframe: 4h  
Equity points: 14,238 per strategy

| Strategy | Trades | Max trade-field difference | Max equity difference | Status |
|---|---:|---:|---:|---|
| EMA + negative funding | 82 | 0 | 0 | PASS |
| Long-only 20/50 EMA | 135 | 0 | 0 | PASS |

Funding report ID: `d2d885663677bb7933380082760afaf8d81f0c67a7d77ed5833fa38411da61ff`  
Trend report ID: `6ce34c9a660f1d0a917350605ad02f31756edca91e7ea381df0aa372f10fcda2`

Each report permanently records the SHA-256 of the Python source, the SHA-256 of
the input fixture, the hashes of all 78 data partitions, the strategy program
hash, both engine versions, the configuration, the tolerances, and every
difference found.

## Usage

```bash
npm run backtest:cross-validate -- \
  data/history/binance-usdm/BTCUSDT-PERP/1m/dataset.catalog.json \
  4h \
  funding

npm run backtest:cross-validate -- \
  data/history/binance-usdm/BTCUSDT-PERP/1m/dataset.catalog.json \
  4h \
  trend
```

Implementation:

- `reference/python_reference_backtest.py` — the independent Python engine.
- `scripts/cross-validate-backtest.ts` — fixes the inputs, runs both engines,
  compares field by field, and writes the report.
- `test/reference-backtest.test.ts` — the cross-language regression that runs on
  every `npm test`.

## Limits of this validation

The Python engine currently receives bars that the TypeScript data layer has
already aggregated, so this round covers *strategy indicators and backtest
execution semantics*. It does not independently cover:

- ZIP/CSV parsing.
- Parquet encoding and decoding.
- 1m to 4h aggregation.
- The fallback for missing mark prices.
- Whether the data source itself is correct.
- Margin and liquidation; the primary engine does not model these fully either.

Two implementations can also agree on the same wrong specification. Hand-computed
small samples, documented exchange rules, and third-party results are still
needed. A `PASS` here does not mean every backtest semantic is correct.
