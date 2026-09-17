# Project status and next steps

English | [简体中文](PROJECT_STATUS.zh-CN.md)

Last updated: 2026-08-04
Current stage: backtest service migration Phase 1 (service skeleton + backtest
proxy), Phase 2 (semantic admission gate), and Phase 3 (optimization migration)
delivered
How status is counted: only "code exists, automated tests pass, and it is
verified on real data or an end-to-end example" counts as implemented. A
documented plan alone never counts as a finished product.

Project-wide change policy: every new capability and every fix follows the
[generalization-first acceptance policy](GENERALIZATION_POLICY.md). One passing
example is not implementation; it also needs a parameter variant, a structural
variant, a boundary/rejection case, and semantic consistency evidence.

## 1. Where things stand

The project has a deployable web research slice: a user can generate and clarify
a strategy in natural language, inspect the machine contract and the program, and
after confirming, run a deterministic backtest on local-first Binance historical
candles, with indicators, price, trade markers, the equity curve, and individual
fills. The DeepSeek provider has passed real generation, conversational revision,
and full-history backtest acceptance; the OpenAI provider has only mock
verification.

Stage 2 of the "parameter optimization lab under locked strategy semantics" was
completed on 2026-07-31. The system now isolates information at roughly 56%
training, 24% development validation, and 20% one-shot final blind of total
history; it supports indicator warm-up separated from the performance window,
3-fold anchored walk-forward, parameter neighborhood perturbation, fee and
slippage pressure, market-regime evidence, disclosure of the multiple-selection
penalty, atomic blind-test receipts, and an immutable parameter version after a
pass. That gate produces research versions only; it is not proof of future
returns. Rigorous statistical significance, order-book-level impact, async jobs,
and the AI experiment researcher are all still missing.

## 2. Done and verified

### 2.1 Product, technical, and business design

- [x] Product positioning, target users, capability map, stage gates, and product
      hypotheses are documented.
- [x] The code-first strategy direction is settled: the model generates
      constrained TypeScript, and the DSL is only an internal IR and audit
      summary.
- [x] The target architecture and technology choices for the control plane, data
      plane, and trading plane are documented.
- [x] The business sequence is settled: a research/paper SaaS first, then
      controlled live trading and a strategy network.
- [x] Subscription price hypotheses, GTM, compliance gates, operating metrics, and
      a 90-day validation plan are documented.

Note: those are design artifacts. They do not mean user interviews, payment
pre-screening, legal opinions, or commercial conversion have happened.

### 2.2 Strategy program prototype

- [x] A single `defineStrategy({...})` program entry point.
- [x] AST static checks that reject imports, network access, process access,
      dynamic code, non-deterministic clocks, loops, dangerous properties, and
      similar capabilities.
- [x] TypeScript transpilation, normalized JavaScript, and a SHA-256 program
      hash.
- [x] Isolated QuickJS/WASM execution with time and memory limits.
- [x] One backtest reuses a persistent QuickJS runtime, so the program loads once.
- [x] EMA uses an incremental cache inside the sandbox rather than recomputing all
      history on every bar.
- [x] Strategy SDK context: OHLCV, funding, OI, account, position, persistent
      state, and bounded history windows.
- [x] Indicators: SMA, EMA, highest, lowest, percent change, standard deviation,
      RSI, ATR, MACD, Bollinger Bands, cross above/below.
- [x] Multi-timeframe reads across 1m, 15m, 1h, and 4h, exposing only
      higher-timeframe bars that have already closed at the current primary-bar
      moment, which prevents lookahead leakage.
- [x] Decisions: hold, open, close, with runtime output validation.
- [x] Golden example strategies and an end-to-end demo.

Implemented in:

- `src/compiler/`
- `src/runtime/sandbox.ts`
- `src/strategy-sdk.ts`
- `examples/strategies.ts`

### 2.3 Bar-level backtest prototype

- [x] Signals on closed bars, filled at the next bar's open.
- [x] Long/short, fixed notional sizing, and sizing from stop-loss risk.
- [x] Taker fees, fixed-bps slippage, and a maximum leverage limit.
- [x] Stop loss, reward-to-risk take profit, funding, and end-of-period
      liquidation.
- [x] Partial close (scaling out): a close decision may carry a `fraction` in
      (0,1] that reduces the position proportionally. Entry fees, entry slippage,
      and accumulated funding are apportioned to that fill by the fraction
      closed, while the remaining position keeps its original entry, stop, and
      target prices. The contract records the same fraction as `closeFraction`,
      with `null` meaning a full close. Because contract rules are an unordered
      set, a scale-out leg must be mutually exclusive with the full-close leg, and
      a `state.*` flag must guarantee each position triggers it only once.
- [x] When a stop and a target trigger on the same bar, the stop is
      deterministically treated as happening first.
- [x] Trade records, equity curve, and strategy state output.
- [x] Slippage cost recorded separately.
- [x] Net return, CAGR, maximum drawdown, Sharpe, Sortino, profit factor,
      expectancy, win rate, exposure, fees, funding, and slippage metrics.
- [x] The report ID is permanently bound to the engine version, strategy hash,
      data partition hashes, timeframe, and backtest configuration.

Implemented in `src/runtime/backtest.ts`.

### 2.4 1m historical data infrastructure

- [x] Raw data normalized to 1m; 15m, 1h, and 4h are deterministically aggregated
      from it.
- [x] A download client for recent Hyperliquid 1m candles and funding.
- [x] Binance Vision monthly packages with official SHA-256 verification and
      resumption.
- [x] A streaming importer for Kraken's complete OHLCVT ZIP.
- [x] A downloader that aligns three Binance USD-M perpetual sources monthly:
      traded candles, mark price, and funding.
- [x] Monthly Parquet partitions, partition manifests, data SHA-256s, and a global
      catalog.
- [x] Millisecond, microsecond, and second timestamp normalization.
- [x] Duplicate, invalid-OHLC, and data-gap checks.
- [x] Verified partitions are skipped on a re-run, and incomplete aggregation
      buckets never enter a backtest.

Implemented in:

- `src/data/`
- `scripts/download-binance-history.ts`
- `scripts/import-kraken-history.ts`
- `scripts/download-hyperliquid.ts`

### 2.5 Completed real-data verification

A full year of Binance Spot `BTCUSDT` for 2024 has been downloaded and verified
locally:

| Item | Result |
|---|---:|
| 1m rows | 527,040 |
| Theoretical minutes | 527,040 |
| Missing minutes | 0 |
| Monthly Parquet partitions | 12 |
| Complete 1h bars | 8,784 |
| Incomplete 1h buckets | 0 |
| ZIP cache | about 31 MB |
| Parquet + manifest | about 19 MB |

Data directory: `data/history/binance-spot/BTCUSDT/1m/`. It is Git-ignored and
exists only on this machine.

That data has been fed through a backtest: a full year of 2024 1m data aggregated
into 2,196 4h bars, running a long-only 20/50 EMA engineering baseline that does
not depend on funding.

| Metric | Result |
|---|---:|
| Initial capital | 10,000 |
| Final equity | 11,454.89 |
| Net return | 14.55% |
| Maximum drawdown | -7.65% |
| Sharpe | 1.66 |
| Profit factor | 2.62 |
| Trades | 19 |
| Win rate | 31.58% |
| Fees | 37.53 |
| Slippage cost | 16.68 |
| Backtest hot-path time | about 0.46–0.48 seconds |

The same 2,196 bars previously took about 21 seconds; the persistent sandbox and
incremental EMA cut that by roughly 44x. The report ID is `b70ee9ec...b68c2`, and
two runs on identical input both produced a report file with SHA-256
`fab7bbc6...f6012`.

That is a single-year, single-market, in-sample engineering baseline. There is no
out-of-sample validation, and it is not evidence of strategy effectiveness or
future returns.

#### BTCUSDT perpetual, 2020–2026

Binance USD-M `BTCUSDT-PERP` is complete from 2020-01-01 to 2026-06-30:

| Item | Result |
|---|---:|
| 1m traded candles | 3,417,120 |
| Theoretical minutes | 3,417,120 |
| Missing / duplicate / invalid trades | 0 / 0 / 0 |
| Funding events | 7,119 |
| Monthly partitions | 78 |
| Missing mark prices | 13,015 (about 0.38%) |
| Complete 4h bars | 14,238 |
| ZIP cache / Parquet | about 232 MB / 140 MB |

Minutes with a missing mark price fall back to the traded close, disclosed in the
partition quality information and in the catalog. The data ends at the last
complete UTC month; the current month's live tail is not merged.

Two engineering baselines have been run:

| Strategy | Trades | Net return | CAGR | Max drawdown | Sharpe | Profit factor |
|---|---:|---:|---:|---:|---:|---:|
| EMA + negative funding | 82 | -16.29% | -2.70% | -17.12% | -0.75 | 0.53 |
| Long-only 20/50 EMA | 135 | 32.15% | 4.38% | -20.45% | 0.54 | 1.38 |

The funding strategy's negative result is a valid verification outcome, and the
logic must not be changed in order to produce a positive return. Neither has had
out-of-sample, parameter-sensitivity, or independent-engine validation, and
neither is evidence of strategy effectiveness or future returns.

### 2.6 Engineering and strategy-semantics verification

- [x] `npm test`: 15 test files, 57 tests, all passing.
- [x] `npm run typecheck`: passing.
- [x] Automated tests cover the data parser, timestamp normalization, complete
      bucket aggregation, and Parquet/catalog round-trips.
- [x] Re-running the local 2024 data verified and correctly skipped all 12
      partitions by hash.
- [x] 20 golden semantic strategies covering trend, breakout, mean reversion,
      funding, long/short, RSI, ATR, MACD, Bollinger Bands, and multi-timeframe.
- [x] 100 Chinese/English, colloquial, and strict phrasings mapping to those 20
      golden intents. This is a synthetic evaluation set and does not pose as real
      user language.
- [x] Rules are extracted back out of the generated program and compared clause by
      clause with the model's machine contract.
- [x] Positive cases and per-condition negative cases are generated from the
      contract; 123/123 behavioral scenarios pass.
- [x] Timeframe, cross direction, long/short, sizing, stop-loss, and exit errors
      are injected automatically; 100/100 mutant programs are rejected.
- [x] `npm run semantics:golden` re-runs those semantic and mutation gates
      independently.
- [x] `npm run semantics:deepseek` runs a real-model evaluation over the 100
      synthetic phrasings, with concurrency, filtering, resumption, content
      fingerprints, atomic reports, token/latency/cost statistics, and semantic
      recomputation that does not call the model again.
- [x] The first DeepSeek V4 Pro baseline passed 86 of 100: 9 contract mismatches,
      5 generation errors, 0 provider errors; P50/P95 latency about 35.7/126.1
      seconds, 637,593 tokens total, estimated at $0.3382 at the prices in effect
      during the evaluation.
- [x] The full V3 evaluation passed 94/100: 5 contract mismatches, 1 generation
      error, 0 provider errors; 22 automatic repairs, P50/P95 latency about
      37.9/100.5 seconds, 581,118 tokens total, estimated $0.2889.
- [x] V3 failures were traced to the percentChange unit explanation, contract
      indicator prefixes, Donchian OHLC fields, and level/crossing ambiguity in
      the corpus; after fixing those, the V4 targeted regression passed 6/6.
- [x] The full V4 evaluation passed 100/100: 0 contract mismatches, 0 generation
      errors, 0 provider errors; 21 automatic repairs, P50/P95/max latency about
      34.4/84.7/248.1 seconds, 587,528 tokens total, estimated $0.2839.
- [x] Internet phrasing collection v0.1: the official Stack Exchange API, a GitHub
      license allowlist, HTML/Markdown cleaning, source hashes, relevance scoring,
      exact and near-duplicate removal, atomic JSONL, and checkpoints are
      implemented.
- [x] The first real-API collection is verified: 493 records stored from Stack
      Exchange and 10 licensed records from GitHub; filtering produced 495 machine
      candidates, of which 472 are highly relevant and 23 possibly relevant, and a
      re-run hit the checkpoint.
- [x] An auditable human annotation chain: independent review, adjudication,
      character-exact quotes from the source, candidate SHAs, stale-adjudication
      protection, a two-reviewer gate, and golden-set splits isolated by author and
      repository.
- [x] The first stratified 25-item review queue is generated; 0 items are
      human-reviewed so far, and no candidate or AI suggestion is counted as
      golden data.
- [x] Dual-lane read-only DeepSeek suggestions (prose and code) are implemented;
      a trial on the first three real items caught one illegal quote in one lane
      and one semantic conflict, neither of which was written into the formal
      annotations.
- [x] Two 25-item blind review packages are generated and verified: identical
      candidates, keeping only the source text, hash, title, language, and an
      empty review form, with no source, author, score, or AI suggestion leaking
      through.
- [x] Dual-review agreement and adjudication tooling is implemented: disposition
      and full-decision agreement, Cohen's kappa, an identity-blinded adjudication
      package, disputed-first ordering, and pre-filled adjudication references.
- [x] The whole-engine evaluator for a real golden set is wired to the first
      action, contract comparison, program reverse semantics, behavioral
      scenarios, and mutation testing; it runs development only by default, and
      blind requires explicit authorization.
- [x] The three product actions are verified with real calls: a complete synthetic
      intent returns `ready` and passes the semantic gate; the vague "make me a
      BTC strategy" returns a specific question; and a clear options
      implied-volatility strategy returns a separate `unsupported` capability
      rejection.

Note: V4's 100/100 is an engineering regression result on a fixed synthetic
corpus. It is not product accuracy, and it is no substitute for real user
language, an unseen test set, or repeated random runs.
The small internet sample is likewise only unreviewed candidates; the review
infrastructure is complete, but there is still no golden contract or real
accuracy number.

### 2.7 The natural-language strategy product slice

- [x] A DeepSeek OpenAI-compatible Chat Completions provider using JSON output,
      with one format retry on empty or invalid JSON.
- [x] An OpenAI Responses API provider adapter using strict JSON Schema structured
      output, as an optional fallback.
- [x] Default `deepseek-v4-pro`; provider and model can be overridden by
      environment variable or CLI, and API keys are read only from the
      environment.
- [x] The model generates complete strategy source, a user explanation,
      assumptions, warnings, and a change summary.
- [x] The model also outputs an independent machine semantic contract; the
      platform extracts semantics back out of the program and checks both
      statically and dynamically.
- [x] The compiler gained full TypeScript semantic checking, which catches
      invented SDK methods and wrong decision types.
- [x] Compile errors return code/message/line/column and enter at most two rounds
      of targeted repair.
- [x] Semantic mismatches also enter targeted repair; missing information returns
      `needs_clarification` with a question, and a capability gap returns
      `unsupported` with the gap. Quietly substituting an approximate strategy is
      forbidden.
- [x] A local CLI with `new`, `revise`, and `show`; "change the stop to 3%"
      creates a new version.
- [x] Strategy versions are immutable JSON files recording the parent version,
      source hash, model, repair history, source diff, and backtest summary.
- [x] The new product layer was re-run locally on the 2020–2026 perpetual data:
      the report ID matches the original baseline, proving the backtest semantics
      did not change.
- [x] Verified with real DeepSeek calls: the initial generation compiled on the
      first try, and "change the 5% stop to 3%" changed only the version and the
      stop-loss line, with no repair triggered.
- [x] The new semantic gate is verified with real DeepSeek calls: RSI, EMA+ATR,
      and 15m-with-closed-1h multi-timeframe strategies all passed with zero
      repairs, with the model contract, the program's reverse extraction, and the
      positive and negative scenarios in agreement.
- [x] The revised version ran against 2020-01 to 2026-06 perpetual data:
      3,417,120 1m bars, 14,238 4h bars, 135 trades, report ID
      `2e70fbf...d7a92`.
- [ ] The OpenAI provider has not been verified with a real API key; this does not
      affect the current DeepSeek default path.
- [ ] There are 100 synthetic phrasings, 495 internet candidates, and a 25-item
      queue awaiting review, but no real-language evaluation set with completed
      dual review and adjudication.

### 2.8 The web customer research loop

- [x] Natural-language input, question-by-question follow-ups, same-language
      results, the machine contract, a read-only program view, and a user
      confirmation interface.
- [x] The customer path is unified as "describe the strategy → confirm the
      interpretation → validate on history → optimize automatically". Each step
      highlights one user question and one primary action, with professional
      evidence kept behind progressive disclosure. Step 4 is described to the
      customer as "AI finds better parameters automatically and proves it was not
      luck", while explicitly not promising "optimal" and keeping the original
      parameters when nothing better is found.
- [x] The input page prompts for entry, action, sizing, and exit; a backtest
      requires only dates by default, with advanced fees and leverage behind
      disclosure; results lead with a plain-language conclusion, the core metrics,
      and the trade chart before moving into the parameter robustness lab.
- [x] The machine contract is translated into Chinese rule cards by a general
      renderer (full condition-syntax coverage, with an unknown expression falling
      back to its literal form rather than guessing). The confirmation step shows
      a plain-language summary and the rules one by one, then asks a single
      "correct / not quite" decision, merging understanding-confirmation and
      feedback into one action.
- [x] The whole flow was rewritten in customer-facing language: a persistent
      four-step progress bar at the top, one main question and one main button per
      step, and backtest results leading with a conclusion card and large numbers,
      with the run ID, elapsed time, cache, split charts, and candidate tables all
      collected behind progressive disclosure. Decorative English labels were
      removed.
- [x] The visual system was rebuilt as a "professional, trustworthy research
      workbench": a neutral light background, white cards, one deep blue primary
      color, and semantic colors (green positive, red negative, amber notice),
      dropping hard shadows, rotations, and clashing color blocks, with hierarchy
      carried by weight, whitespace, and 1px borders instead. The candlestick
      chart moved to a light theme, with dark arrows for entries, green/red for
      exits by PnL, and the primary color for the equity curve.
- [x] Chinese typography was normalized: headings at zero letter-spacing with a
      line height of at least 1.28, display sizes capped at 46px with
      `text-wrap: balance` and `line-break: strict`; body text at 1.75 line
      height, nothing a customer must read below 12px, and numbers uniformly
      monospaced with tabular-nums.
- [x] The backtest range offers shortcuts that change with the timeframe (three
      each for 1m/15m/1h and above), and the results end with a clear "go run the
      robustness test" next step.
- [x] A confirmed contract is read from the server; the browser cannot inject
      rules or a program.
- [x] Layered candle reads: local static library → R2 object cache → Binance
      official archive/REST cold start.
- [x] Backtest results are cached in R2 and memory, with a key covering the
      contract, data digest, dates, fees, slippage, leverage, and the engine's
      semantic version.
- [x] Deterministic execution — close signal, next-bar-open fill, stop-first on
      the same candle — plus visualization of indicators, trade markers on the
      candles, the equity curve, and individual trades.
- [x] Backtest results carry indicator plot series: every indicator reference in
      the locked contract's conditions and risk expressions (including those
      inside `crossAbove`, higher-timeframe prefixes, and ATR stop expressions) is
      extracted and evaluated bar by bar on the primary timeframe using the same
      indicator implementation the execution uses, with lag offsets normalized
      onto one line. Price-scale indicators overlay the candles, while RSI, MACD,
      ATR, and percent change each get their own panel. At most 6 lines per
      response, and anything beyond that affects only plotting, never execution.
- [x] A backtest can be replayed: the chart draws the full history by default, and
      pressing play advances bar by bar through candles, indicators, buy/sell
      markers, and the equity curve, showing the current bar's time, close,
      position side, completed trade count, realized PnL, and account equity.
      1x/2x/4x/8x speed, pause, dragging to any bar, and show-everything are all
      supported. Replay only re-renders records that backtest already produced; it
      recomputes nothing and changes no conclusion.
- [x] D1 stores strategy submissions, feedback, backtest receipts, and experiment
      records.
- [x] Google OAuth 2.0 (Authorization Code + PKCE) login, server-side sessions
      (raw token in the cookie, SHA-256 in the database), an anonymous workspace
      cookie, and automatic claiming after login.
- [x] Object ownership: `users` and `auth_sessions` tables, with `user_id` added
      to three business tables. Authorization is always derived from the
      server-side cookie, and a session identifier in the request body is no
      longer trusted; steps 3 and 4 require an account on the server.
- [x] The information architecture is now stepped routes: `/[locale]` (landing),
      `/[locale]/new`, `/[locale]/s/[id]/{confirm,backtest,optimize}`,
      `/[locale]/strategies`, and `/[locale]/account`; the four-step bar at the
      top became navigation you can go back through; the confirmation state is
      persisted as `confirmed_at`, so a refresh or a shared link returns to the
      right step.
- [x] Chinese and English: `/zh` and `/en` path prefixes, with the locale parsed
      from the pathname by the worker and injected as a trusted header; a
      type-safe dictionary (`en` constrained by `typeof zh`); the contract
      renderer dispatching to per-language sentence builders; API errors returning
      a stable code plus parameters rendered by the frontend per language; and the
      model's output language following the interface language, with
      `STRATEGY_CACHE_VERSION` bumped to `strategy-intent-v4-explicit-locale`.
- [ ] Sharing, subscriptions, billing, and asynchronous backtest jobs are not
      done.

### 2.9 Accounts, the stepped flow, and internationalization

- [x] Login is Google OAuth. The platform-reserved `/callback` path is left
      untouched; the callback is `/api/auth/google/callback`, with its address
      derived from request headers so local and production do not diverge.
- [x] The OAuth state and PKCE verifier live in a short-lived HttpOnly cookie; the
      callback validates state, issuer, audience, and expiry, and the id_token
      comes from a direct TLS connection to the token endpoint.
- [x] An anonymous visitor can complete steps 1–2 (describe, confirm); from step 3
      the server returns `AUTH_REQUIRED`. Anonymous quotas are lower than
      logged-in quotas.
- [x] The deterministic ID for a parameter experiment now reads `session_id` from
      the strategy row, so experiment receipt IDs no longer drift after an
      anonymous record is claimed.
- [x] The worker strips any client-sent header of the same name before injecting
      the trusted identity header, so forging `x-prooftrade-user-id` does nothing.
- [x] The My Strategies list returns progress badges and the latest backtest
      metrics from one aggregate query, supporting continue, rename, and
      archive-delete.
- [x] Eight automated identity and ownership tests: anonymous pass-through, the
      login gate, cross-session isolation, header forgery, PKCE/state,
      cross-site `return_to`, claim scope, and rejection of a wrong audience.

Note: login covers Google only; email login and wallet binding from
`PRODUCT_SPEC.md` 5.1 are still unimplemented. The design is in
[web product design](WEB_PRODUCT_DESIGN.md).

### 2.9 The semantics-locked parameter optimization lab, Stages 1–2

- [x] Numeric parameters — indicator periods, comparison thresholds, arithmetic
      constants, sizing, stop loss, and take-profit reward-to-risk — are
      discovered automatically from any machine contract, with no dependence on a
      specific instrument, a user's sentence, or an example constant.
- [x] Lag/offset is not a default tunable parameter; the trading timeframe,
      actions, direction, indicators, fields, comparison operators, boolean
      structure, and fill timing all enter the semantic lock fingerprint.
- [x] The browser submits only server-issued parameter IDs, ranges, and value
      points; the server builds candidates from the original immutable contract
      and re-validates the semantic fingerprint.
- [x] At most 4 parameters and 16 candidates per run; the web default is 12
      candidates, using deterministic values and sampling, so identical inputs
      reproduce.
- [x] The same local candles load once, experiment results use a memory/R2 cache,
      and D1 stores the experiment receipt and the full candidate evidence.
- [x] Roughly 56% training, 24% development validation, and 20% final blind of
      total history, isolated chronologically; the output includes the baseline,
      the recommended candidate, the Pareto front, and the full ranking.
- [x] Unknown parameters, duplicate parameters, illegal ranges, too many
      parameters, and out-of-bound values are rejected by the server.
- [x] Indicator warm-up may read history before the performance window, but that
      warm-up range does not trade, place orders, or count toward performance.
- [x] Three anchored walk-forward windows, one-step parameter sensitivity,
      current/double/severe cost pressure, and four relative market-regime
      evidence categories.
- [x] The candidate count and a selection-penalized Sharpe heuristic are
      disclosed, explicitly stated as not equivalent to the Deflated Sharpe Ratio
      or to statistical significance.
- [x] The last 20% of history stays sealed until the pre-gates pass; the same
      session, strategy, parameters, data, and configuration map to one
      deterministic experiment ID, and atomic state guarantees a single
      execution, with later requests reusing the same immutable receipt.
- [x] After a blind pass, the user confirms creation of one immutable
      `contract-derived` parameter version, keeping the parent version, the
      experiment, the semantic lock, and the parameter diff; a repeated request
      does not create a second one.
- [ ] Stage 3: AI as read-only experiment designer and result explainer. It never
      performs numeric execution and cannot modify historical results.
- [x] Materializing the parameter version's TypeScript source is implemented on
      the service path (`/v1/optimization/materialize` plus `program-apply.ts`);
      an adopted version carries real program source
      (`programStatus: program-derived`). The old path (no service configured)
      still falls back to an empty-source contract-derived version.
- [ ] An async task queue, per-user concurrency and cost quotas, cancellation, and
      persisted progress are not done.

### 2.10 Data field expansion + backtest service migration Phase 0 (2026-08-04)

- [x] The remaining Binance 12-column kline fields are now read:
      `quote_asset_volume` (7), `taker_buy_base_volume` (9), and
      `taker_buy_quote_volume` (10) are stored, round-trip through Parquet
      snapshots, sum through 15m/1h/4h aggregation, and are exposed by the SDK,
      sandbox, compiler declarations, and prompt as `market.quoteVolume` and
      friends (`null` when absent), usable as the field argument to `sma`, `ema`,
      `highest`, `lowest`, `standardDeviation`, `bollingerBands`, and
      `percentChange`. Parsing, round-trip, and aggregation tests cover them.
      Existing ZIPs need no re-download, only a re-parse.
- [x] The single-engine golden baseline `test/engine-golden.test.ts` pins 7 cases:
      threshold/state, 20/50 EMA, negative funding (including funding PnL), open
      interest, multi-timeframe (15m primary with a closed 1h RSI), and same-bar
      stop/target collision (stop first). It is the regression baseline for the
      backtest service migration.
- [x] The root `vitest.config.ts` excludes `web/`, so the root `npm test` no
      longer picks up the web package's tests (the web app has its own
      `node --test` suite).
- [ ] Quantifying live cross-engine divergence is deferred to Phase 1 shadow mode;
      the root package and `web/` are isolated (the web engine depends on fflate
      and Cloudflare types, which the root `tsc` cannot import). See
      `docs/BACKTEST_SERVICE_PLAN.md` Phase 0.

### 2.11 Backtest service migration Phases 1 and 2 (2026-08-04)

- [x] An independent Node Fastify service, `services/backtest/`: `POST
      /v1/backtest` (compile → `runBacktest` → metrics) and
      `POST /v1/strategy/verify` (compile + typecheck + reverse semantic check +
      positive and negative behavioral scenarios + capability scan), started from
      the root with `npm run backtest:service`.
- [x] Shared contracts in `src/contracts/`: the `backtest-1.0`, `verify-1.0`, and
      `error-1.0` wire formats and types.
- [x] The single engine gained `equityPercent` sizing (core types, sandbox,
      backtest, SDK declaration, semantic extraction), so the CLI sandbox covers
      every `sizeKind` in the web contract.
- [x] `src/semantics/capabilities.ts` statically scans which data capabilities a
      program uses (ohlcv, turnover, markPrice, fundingRate, openInterest,
      multiTimeframe, state, indicators, arithmetic), covering direct field reads,
      indicator and history field arguments, timeframe views, and destructured
      `market`.
- [x] The web app's `/api/backtest/run` proxies to the service and executes the
      real program when `BACKTEST_SERVICE_URL` is set, falling back to the old
      interpreter when it is not; `BACKTEST_SHADOW_MODE="true"` runs the old
      interpreter alongside and alerts on divergence beyond a threshold; the cache
      key includes the engine and moved to `backtest-v5-engine-service`; and
      `vite.config.ts` injects a default of `http://127.0.0.1:8780`.
- [x] The web analyze semantic admission gate: a `ready` artifact calls
      `/v1/strategy/verify` before being stored and is persisted only on a pass; a
      mismatch returns `STRATEGY_VERIFY_FAILED`; funding/OI/mark/turnover
      capability gaps are downgraded to `unsupported` during analyze with the gap
      disclosed, rather than throwing an `OHLCV_ONLY` 500 at backtest time; and an
      unreachable service returns `STRATEGY_VERIFY_UNAVAILABLE` (503 with
      `Retry-After: 30`) instead of falling back and storing.
- [x] Gate fallback defect fixed (2026-08-04): the old "fall back to
      `structuralChecks` when the service is unreachable" behavior stored
      unverified programs as `ready`. The model had produced a different dialect
      (missing `id`/`version`, using `openLong()`/`closePosition()` instead of
      returning a decision from `onBar`), and 6 of the 10 surviving local records
      could not compile — one of which the user had already confirmed, so every
      backtest returned `COMPILE_FAILED` (flattened to a 400 by `fail(code, 400)`;
      a 500 `BACKTEST_FAILED` when the service was down). Three fixes: analyze
      blocks during an outage; the web prompt inlines `STRATEGY_SDK_DECLARATION`
      and the cache version was bumped; and `COMPILE_FAILED`, `SOURCE_MISSING`,
      `BACKTEST_SERVICE_ERROR`, `NOT_RUNNABLE`, `NOT_CONFIRMED`, and
      `STRATEGY_VERIFY_UNAVAILABLE` gained Chinese and English copy (they
      previously fell through to "an unknown error occurred").
- [x] Expression-valued contracts (2026-08-05): decision fields moved from bare
      literal-only fields to the same expression syntax as conditions, and
      `ContractDecision.stopLossPercent` and `takeProfitRiskReward` widened to
      `number | string | null` (constants are still stored as numbers, and reading
      back a historical contract is unchanged). This also fixed a long-standing
      live defect: the prompt had always promised the model "safe + - * /
      arithmetic", but `canonicalOperand` in `extract-semantics.ts` only accepted
      leaf operands, so any condition with arithmetic was recorded as
      `opaqueConditions`, and `verify-semantics` emitted a diagnostic on seeing
      opaque — which meant the gate always rejected it. New:
      `src/semantics/expression.ts` (pure strings: evaluation, operand
      enumeration, parenthesis normalization) and `expression-ast.ts` (AST
      normalization, isolating the typescript dependency so it does not end up in
      the worker bundle). A dynamic ATR stop can now be expressed as
      `"atr(14,0)/market.close*2"`, verified end to end, and tampering with the
      contract multiplier from 2 to 3 is rejected by the gate — expressiveness
      improved without sacrificing checkability. Expression stops do not
      participate in tuning (overwriting with a number would discard the whole
      formula); the old web interpreter cannot evaluate expressions and throws
      `EXPRESSION_NEEDS_SERVICE_ENGINE`, while the service engine executing the
      real program is unaffected.
- [x] Incremental sandbox indicators (2026-08-04): `__rsi`, `__atr`, and `__macd`
      previously recomputed from index 0 on every bar, making a full backtest
      quadratic in bar count. They now accumulate per bar like `__ema`, with
      `__series` filled lazily; operation order and arithmetic are identical and
      values match bit for bit. On 10,000 bars: RSI alone 10.9s → 0.29s;
      RSI+ATR+MACD 32.1s → 0.33s.
- [x] 15 new root tests: the service's `/v1/backtest` (including equityPercent and
      funding) and `/v1/strategy/verify` (pass / capability gap / rule mismatch /
      compile failure), plus 6 capability-scan groups. `npm test` is 19 files and
      86 tests all passing, `npm run typecheck` passes, and the web package's
      `tsc --noEmit` passes.
- [ ] Deleting the web engine (`IndicatorEngine`, `runContractBacktest`, regex
      condition interpretation) is deferred to Phase 5; the optimization path
      (`/api/optimization/*`) is still on the old engine and migrates in Phase 3.
- [ ] Production web-to-service authentication (shared secret / mTLS plus request
      signing) and service deployment (Cloud Run / Fargate) are not done; the local
      `node --test` web suite needs `npm run build` first and must be re-run by the
      user.

### 2.12 Backtest service migration Phase 3: optimization migration (2026-08-04)

- [x] `runBacktest` supports `evaluationStartTime` for performance-window
      separation: history before the window feeds indicator warm-up and does not
      trade, record equity, or count; pinned by golden tests
      (`test/backtest-window.test.ts`).
- [x] `src/optimization/`: parameter discovery and application (IDs identical to
      the web app's), candidate generation, trial evaluation, walk-forward /
      sensitivity / cost pressure / market regime / multiple-selection penalty
      gates, and pure-computation blind testing — all executing the real program.
- [x] `src/optimization/program-apply.ts` locates a contract-relative parameter
      (`rule.N.when.M.number.K`, `rule.N.decision.*`) in the program AST's numeric
      literals by canonical rule/condition matching and rewrites the source;
      hoisted indicator variables, decision fields, thresholds, and state
      strategies are all tested (6 tests in `test/optimization-apply.test.ts`).
- [x] Service `POST /v1/optimization/run|blind|materialize`; the web app's
      `/api/optimization/run|blind` proxies to the service when
      `BACKTEST_SERVICE_URL` is set; adopt stays in the web app, and the D1
      `blind_status` atomic state machine is unchanged.
- [x] Parameter-version source materialization: adopt generates a real program
      through `/v1/optimization/materialize` (`programStatus: program-derived`),
      closing the "blank source on a parameter version" gap.
- [x] The cache key includes `engine` + `sourceHash` at
      `optimization-v4-engine-service`; `npm test` is 23 files and 102 tests all
      passing, root and web typechecks pass, and the service loads under tsx.
- [ ] Async trials, cancellation, and persisted progress are deferred to Phase 4;
      production deployment and authentication are still to do; the local web
      `node --test` suite needs `npm run build` first and must be re-run by the
      user.

## 3. Implemented but not yet verified

### 3.1 A decade of Kraken BTC 1m

- [x] The importer is written and can stream `XBTUSD_1.csv` and write monthly
      Parquet.
- [ ] Kraken's full ZIP has not been downloaded on this machine.
- [ ] The decade from 2016-01-01 to 2026-01-01 has not actually been imported and
      checked for total rows, missing minutes, first and last prices, and
      outliers.
- [ ] Automatic merging of Kraken's quarterly increments and revision version
      management are not implemented.

Note: Google Drive may block the automated download; the code supports importing
a manually downloaded official ZIP with `--archive`.

### 3.2 Recent Hyperliquid data

- [x] The recent 1m candle and funding client and the snapshot writer are
      written.
- [ ] No fixed Hyperliquid BTC snapshot has been stored as an
      outside-the-repository test baseline.
- [ ] No mock or real-endpoint integration tests exist for the Hyperliquid client.
- [ ] The ordinary candle API covers only about the last 5,000 1m bars and cannot
      carry a decade of history.

### 3.3 Real backtests

- [x] A catalog can be loaded, verified, aggregated, and fed into a backtest.
- [x] A yearly backtest with real entries and exits has been completed using an
      EMA trend baseline matched to spot fields.
- [x] A complete JSON report with a fixed ID, a trade list, an equity curve, and
      the core metrics has been produced.
- [x] The funding and trend strategies have been cross-validated trade by trade
      and equity point by equity point against a stdlib-only Python reference
      engine.
- [x] 217 trades and 28,476 equity points, with a maximum absolute difference of 0
      on both.
- [ ] Data parsing, Parquet, and 1m→4h aggregation have not been independently
      verified by a second implementation.
- [x] A user-facing web report exists with metrics, trade markers on the candles,
      the equity curve, and individual trades.

## 4. Planned, not done

### P0: finish the research prototype's exit conditions

None of the web MVP starts before these are done:

1. **A long-horizon perpetual dataset**
   - [done] Wire up the Binance USD-M BTC perpetual monthly source.
   - [done] Align traded candles, funding, and mark price, and disclose the mark
     fallback.
   - [done] Spot and perpetual use different venue/instrument values and are never
     silently substituted.
   - [done] Produce 78 immutable monthly partitions and a reproducible catalog.
   - [to do] Wire up 5m open interest for the period where it is available.
   - [to do] Add the current month's daily packages and REST live tail, layered
     separately from the complete monthly fact set.

2. **A meaningful real strategy baseline**
   - [done] Add a trend strategy that does not depend on funding, backtested with
     real fills on 2024 spot data.
   - Then verify the funding strategy on perpetual data.
   - [done] Output net return, maximum drawdown, Sharpe, trade count, win rate,
     fees, funding, and slippage as separate line items.

3. **Backtest performance and correctness**
   - [done] Reuse a persistent QuickJS runtime instead of rebuilding the sandbox
     per bar.
   - [done] Use incremental EMA and per-bar input instead of copying all history
     and recomputing EMA.
   - Add margin, liquidation, maker/taker, a gap policy, and a more realistic
     slippage model.
   - [done] Build the Python reference engine and cross-validate the funding and
     trend strategies trade by trade and equity point by equity point.
   - [to do] Verify CSV/Parquet and timeframe aggregation through an independent
     data path.
   - [to do] Add hand-computed golden cases for margin, liquidation, and
     within-bar collisions.

4. **Strategy compiler completeness**
   - [done] Run full TypeScript typechecking against the Strategy SDK
     declaration.
   - [partial] Verifiable trading rules and actions are extracted; full data
     dependencies, warm-up, state keys, and capability tiers remain.
   - Add limits on state size, output size, and indicator parameters.

5. **Golden strategies and test sets**
   - [done] Build 20 golden semantic strategies and 100 synthetic natural-language
     phrasings.
   - [done] Cover trend, breakout, mean reversion, funding, long/short, RSI, ATR,
     MACD, Bollinger Bands, and multi-timeframe.
   - [done] Pin a program, machine contract, positive and negative behavioral
     scenarios, and mutation expectations for each semantic strategy.
   - [to do] Add stateful strategies and boundary cases, plus fixed market data,
     program hashes, and full backtest results.

6. **The AI generation loop**
   - [done] Wire up DeepSeek as the default provider and OpenAI as a fallback;
     DeepSeek is verified with real calls.
   - [done] Implement natural-language intent → candidate program → structured
     compile errors → targeted repair.
   - [partial] Program reverse semantic extraction, machine contract validation,
     behavioral scenarios, source diffs, and immutable revision versions are
     added; the user confirmation UI is not finished.
   - [done] Build an offline semantic evaluation set of 100 synthetic phrasings.
   - [done] Run three rounds of real DeepSeek generation evaluation (V2, V3, V4)
     over the 100 synthetic intents, recording accuracy, automatic repairs,
     latency, tokens, and cost; V4 passed 100/100 on the full set.
   - [partial] The first batch of real public phrasings has been collected from
     official internet APIs and licensed repositories; it still needs expansion,
     at least 150 human-annotated items, and an independent test set that takes no
     part in prompt revision, plus repeated-run stability evaluation.

7. **Paper runtime consistency**
   - Implement event recording and replay.
   - Verify that backtest and paper produce identical signals on the same recorded
     data.
   - Implement state persistence, heartbeats, reconnect backfill, pause, and
     resume.

The original Phase 0 exit condition stands: the 20 preset strategies compile
reliably and reproduce their results on fixed data.

### P1: closed MVP

- [partial] The web product: natural-language clarification, code and explanation
  views, user confirmation, backtest reports, data charts, and the Stage 1–2
  parameter lab are done; login and conversational version editing are not.
- [ ] The control API, the PostgreSQL data model, object ownership, and idempotent
  endpoints.
- [ ] A backtest job queue, quotas, cancellation, retries, and artifact
  management.
- [prototype done] Immutable strategy versions and source comparison; rollback and
  fork are not done.
- [ ] Live paper deployment, virtual accounts, and monitoring notifications.
- [ ] A share page, basic subscriptions, and usage billing.
- [ ] A closed loop with 30–50 design partners.

### P2: controlled live trading

- [ ] Hyperliquid API / agent wallet authorization.
- [ ] An independent risk engine, execution service, and signing boundary.
- [ ] Client order IDs, order/fill/position reconciliation, and reconnect
  recovery.
- [ ] Maximum position, leverage, daily loss, drawdown, data freshness, and
  reduce-only rules.
- [ ] A dead man's switch, a kill switch, a security audit, and a P0 on-call
  rotation.
- [ ] Builder fee authorization, fee disclosure, and revocation.
- [ ] Legal opinions for target countries, a regional allowlist, terms, and risk
  disclosure.

### P3: the strategy network

- [ ] A public verification record that cannot be selectively deleted.
- [ ] Strategy forks, following, creator pages, and subscriptions.
- [ ] A creator agreement, content moderation, conflict-of-interest disclosure,
  revenue sharing, taxes, and refunds.

## 5. Business execution has not started

The business plan is written, but none of this has been carried out:

- [ ] Interview 30 target traders.
- [ ] Collect at least 100 real natural-language strategies, with 500 as the
  eventual language-coverage target.
- [ ] Test the positioning page, price range, and willingness to pay.
- [ ] Recruit 30–50 design partners.
- [ ] Shortlist 5–8 candidate countries and obtain professional legal analysis.
- [ ] Complete business pre-screening with at least 3 payment or
  merchant-of-record providers.
- [ ] Terms, privacy, risk, and refund policy documents.
- [ ] Brand name, domain, and trademark screening.
- [ ] Named owners for user support, data quality, security, and incident
  response.

Charging money, scaling acquisition, live trading, and creator monetization each
remain gated by Gates A–D in [BUSINESS_PLAN.md](BUSINESS_PLAN.md).

## 6. Settled decisions that should not be relitigated

1. The launch direction is an international crypto strategy research platform,
   for perpetual traders who can describe their trading rules.
2. The model generates programs and never places orders; the deterministic
   runtime and the independent risk engine are the trust boundary.
3. User strategies are constrained TypeScript. We no longer try to wrap every
   intent in a large JSON DSL.
4. Raw candles are normalized to 1m, with other timeframes deterministically
   aggregated.
5. Historical files use immutable Parquet, SHA-256, partition manifests, and a
   dataset catalog.
6. Kraken `XBTUSD` is the candidate for a decade of a single spot market, Binance
   `BTCUSDT` is the fast verification source, and different venues/instruments are
   never concatenated automatically.
7. The launch execution venue is still planned as Hyperliquid, with BTC, ETH, and
   SOL perpetuals first.
8. Sell research/paper subscriptions first; live trading, execution fees, and a
   strategy marketplace must come after the legal, security, and operational
   gates.
9. The platform holds no funds, never asks for a seed phrase or a main wallet's
   private key, and offers no withdrawal or transfer capability.

## 7. Recommended next step

Quantitative infrastructure expansion is frozen for now: no priority on adding
OI, L2, more exchanges, more indicators, or a liquidation model, unless product
validation clearly requires it.

The next unit of work is limited to:

> Expand the internet public-phrasing candidates to about 2,000, human-review 250
> and freeze 150 golden records with provenance, and run a repeatable evaluation
> of generation success rate, automatic repair rate, semantic preservation,
> clarification correctness, latency, and per-run cost. Then wrap the already
> verified CLI loop in a minimal web conversation interface.

V4's 100 synthetic phrasings now form an engineering regression baseline. The
next round stops tuning prompts against that same fixed corpus, to avoid
overfitting the test set.

A fixed in-sample/out-of-sample split still matters, but it belongs to the next
layer of backtest credibility and no longer outranks the natural-language product
loop.

## 8. Common verification commands

```bash
npm test
npm run typecheck
npm run semantics:golden

# Full real DeepSeek evaluation; resumable, and reports are not committed by default
npm run semantics:deepseek -- --limit 100 --concurrency 6

DEEPSEEK_API_KEY="sk-..." npm run strategy:studio -- new \
  --intent "On 4h, go long on a 20/50 EMA golden cross, 5% stop loss, exit on the death cross" \
  --session btc-ema-v1 \
  --dataset data/history/binance-usdm/BTCUSDT-PERP/1m/dataset.catalog.json \
  --interval 4h

npm run data:binance-history -- \
  --symbol BTCUSDT \
  --start 2024-01-01T00:00:00Z \
  --end 2025-01-01T00:00:00Z

npm run backtest:real -- \
  data/history/binance-spot/BTCUSDT/1m/dataset.catalog.json 4h

npm run data:kraken-history -- \
  --pair XBTUSD \
  --start 2016-01-01T00:00:00Z \
  --end 2026-01-01T00:00:00Z
```

## 9. Repository state reminder

The code, documentation, and dependency changes from that session were still in
the working tree and had not been committed to Git. `data/cache/`,
`data/history/`, and `data/snapshots/` are ignored, so locally downloaded data is
never committed with the code and does not appear automatically in another
environment.
