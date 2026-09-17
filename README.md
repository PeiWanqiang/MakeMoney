# Crypto Strategy Studio

English | [简体中文](README.zh-CN.md)

A natural-language strategy platform for crypto traders: it compiles a trading
idea into a deterministic strategy that can be verified, simulated, and executed
under explicit control.

The project is currently a local vertical-slice prototype, so it does not yet
use its final product name.

## Core documents

The design documents are currently written in Chinese.

- [Product specification](docs/PRODUCT_SPEC.md)
- [Strategy program design](docs/STRATEGY_PROGRAM.md)
- [Internal DSL/IR design](docs/STRATEGY_DSL.md)
- [Technical architecture](docs/TECH_ARCHITECTURE.md)
- [Business and market plan](docs/BUSINESS_PLAN.md)
- [Historical market data pipeline](docs/DATA_PIPELINE.md)
- [Project status and next steps](docs/PROJECT_STATUS.md)
- [Internet strategy-intent corpus](docs/INTERNET_INTENT_CORPUS.md)
- [Independent cross-validation of the backtest engine](docs/CROSS_VALIDATION.md)
- [Generalization-first acceptance policy](docs/GENERALIZATION_POLICY.md)

## Settled principles

1. The model writes a constrained TypeScript strategy program; it never submits
   an order directly.
2. Every program is statically checked, hashed into a version, and run in a
   sandbox. Backtest, paper trading, and live trading share one program
   semantics.
3. Paper trading is the default. Live trading requires explicit authorization
   and an independent risk gate.
4. The first venue is Hyperliquid; the first instruments are BTC, ETH, and SOL
   perpetuals.
5. The product never takes custody of user assets, and never accepts seed
   phrases or main-wallet private keys.
6. Trustworthy backtests, an honest live track record, and a high-quality market
   database come before everything else.
7. Every fix must implement the general semantic capability behind the example.
   Patching a specific sentence, constant, or single strategy is forbidden; the
   full bar is in the
   [generalization-first acceptance policy](docs/GENERALIZATION_POLICY.md).

## The natural-language strategy loop

The local CLI implements the first end-to-end product path: a natural-language
intent becomes both a machine-readable semantic contract and constrained
TypeScript (via DeepSeek or OpenAI), which is then checked by an AST validator
and a full TypeScript typecheck, reverse-extracted back into rules, compared
clause by clause against the contract with positive and negative behavioral
scenarios, repaired in at most two targeted passes, explained together with its
assumptions, frozen as an immutable strategy version, and optionally backtested
on real data.

A user revision produces a new version and a source diff; older version files
are never overwritten. An intent the current capabilities cannot express is
rejected with an explicit request for clarification, rather than silently
downgraded into an approximation.

```bash
export DEEPSEEK_API_KEY="sk-..."

# Create a strategy. Without --dataset it only generates, checks, and stores a version.
npm run strategy:studio -- new \
  --intent "On the 4h timeframe, go long when the 20 EMA crosses above the 50 EMA, 5% stop loss, exit on the cross down" \
  --session btc-ema-v1 \
  --dataset data/history/binance-usdm/BTCUSDT-PERP/1m/dataset.catalog.json \
  --interval 4h

# A conversational revision creates a new immutable version.
npm run strategy:studio -- revise \
  --session btc-ema-v1 \
  --intent "Change the stop loss to 3%"

# Show the latest version, or a specific one with --version.
npm run strategy:studio -- show --session btc-ema-v1
```

The default provider/model is DeepSeek `deepseek-v4-pro`; override it with
`--provider deepseek|openai` and `--model`. Set `OPENAI_API_KEY` when using
OpenAI. API keys are read from the environment only and are never written into
session artifacts. For compatibility with older environments that stored only
the key body, the DeepSeek provider restores a missing `sk-` prefix in memory,
without modifying the environment or writing it to disk. Strategy sessions live
in `data/strategy-sessions/` and are Git-ignored by default.

The Strategy SDK supports SMA, EMA, RSI, ATR, MACD, Bollinger Bands, standard
deviation, highest/lowest, percentage change, historical arrays and bars, and
reads across the 1m, 15m, 1h, and 4h timeframes. Higher-timeframe data only
reaches a strategy once the corresponding bar has closed, which rules out
lookahead leakage.

```bash
# Re-run 20 golden semantic strategies, 123 behavioral scenarios, and 100 error variants.
npm run semantics:golden

# Run 100 synthetic natural-language phrasings against the real DeepSeek API; the report is resumable.
npm run semantics:deepseek -- --limit 100 --concurrency 6
```

A live-model evaluation records, per case, the contract differences, repair
count, latency, token usage, and estimated cost, written by default to the
Git-ignored `data/reports/semantic-evals/`. On the full set, DeepSeek V4 Pro
improved from V2's 86/100 and V3's 94/100 to 100/100, with 21 cases passing
through automatic repair and zero contract mismatches, generation errors, or
provider errors. That result comes from a fixed set of synthetic phrasings
only: it is not a substitute for real user language, a held-out test set, or
repeated-run stability measurements.

## Collecting real phrasings from the internet

The first collection pass uses the official Stack Exchange API and GitHub
READMEs with an explicit license. Sources such as Reddit and TradingView stay
out of automated collection until the corresponding permission is in place.
Each collected item carries its source, license, hash, relevance score, and a
checkpoint, and is deduplicated after cross-source filtering. Machine filtering
only produces candidates; nothing becomes a golden strategy automatically.

```bash
npm run intents:collect-stackexchange -- --pages 1 --page-size 50
GITHUB_TOKEN="..." npm run intents:collect-github -- --pages 1 --page-size 25
npm run intents:filter -- --minimum-score 0.3 --near-threshold 0.9

# Build an auditable human review queue. Dual-path AI suggestions are advisory and never become official labels.
npm run intents:review -- queue --reviewer reviewer-1 --limit 25
npm run intents:suggest -- --limit 25 --concurrency 2

# Once the golden set is frozen, evaluate the whole engine on real intents (the blind set is untouched by default).
npm run intents:evaluate -- --split development --concurrency 2
```

Data is written to the Git-ignored `data/internet-intents/` by default. The full
source boundaries, formats, and validation results are in the
[internet strategy-intent corpus](docs/INTERNET_INTENT_CORPUS.md).

## Local data and backtesting

Raw market data is normalized to 1-minute candles and then deterministically
aggregated into 15m, 1h, and 4h. The project has downloaded and verified a full
year of Binance Spot `BTCUSDT` data for 2024: 527,040 candles across 12 monthly
Parquet partitions, with zero missing minutes.

```bash
# Build or resume one year of BTC 1m data.
npm run data:binance-history -- \
  --symbol BTCUSDT \
  --start 2024-01-01T00:00:00Z \
  --end 2025-01-01T00:00:00Z

# Build the BTCUSDT perpetual dataset from 2020 to the last complete month.
npm run data:binance-perp-history -- \
  --symbol BTCUSDT \
  --start 2020-01-01T00:00:00Z \
  --end 2026-07-01T00:00:00Z

# Backtest on real data from a catalog, aggregated to 4h first.
npm run backtest:real -- \
  data/history/binance-spot/BTCUSDT/1m/dataset.catalog.json 4h

# Cross-validate trade by trade and equity point by equity point against an independent Python engine.
npm run backtest:cross-validate -- \
  data/history/binance-usdm/BTCUSDT-PERP/1m/dataset.catalog.json 4h funding

# Import ten years of Kraken BTC/USD 1m data for a single market.
npm run data:kraken-history -- \
  --start 2016-01-01T00:00:00Z \
  --end 2026-01-01T00:00:00Z
```

The downloaders verify the source files, write immutable monthly Parquet
partitions, generate data hashes and a top-level catalog, and verify before
resuming on a re-run. If the automated Kraken download is blocked by Google
Drive, download the full ZIP from the official page and import it with
`--archive /absolute/path/Kraken_OHLCVT.zip`.

## The product path

```text
natural-language idea
  -> AI generates / repairs the strategy program
  -> static safety checks and a full typecheck
  -> reverse explanation, assumptions, immutable version
  -> program hash / internal IR
  -> historical backtest
  -> out-of-sample validation
  -> live paper trading
  -> risk review
  -> user-authorized live trading
  -> continuous monitoring and review
```

## Development

```bash
npm ci
npm run typecheck
npm test
```

Security reports are handled through the process in [SECURITY.md](SECURITY.md).

## License

This project is licensed under the [MIT License](LICENSE).

This software is for research and informational purposes only and is not
investment advice. Trading crypto can lose your entire principal; anyone
running it against real money accepts full responsibility for the outcome.
