# Backtest service rework (Path A: one engine)

English | [简体中文](BACKTEST_SERVICE_PLAN.zh-CN.md)

Status: Draft v0.1
Decision: the CLI sandbox engine is the only semantic authority. The web app
stops interpreting machine contracts and calls an independent Node execution
service instead.

## 1. Goals

- **One engine**: the real TypeScript strategy program (AST validation + full
  typecheck + QuickJS sandbox execution) is the only executor for every backtest
  and optimization. The machine contract becomes an audit record, not the
  execution truth.
- **No forked engines**: delete the web app's `IndicatorEngine`,
  `runContractBacktest`, and regex condition interpreter.
- **Execution separate from serving**: the web app (a Cloudflare Worker) stays a
  serverless frontend and control plane; execution moves into an independent Node
  service that can scale on its own and carry long jobs.
- **A semantic admission gate**: a `ready` strategy must already pass the
  program-versus-contract reverse check and behavioral scenario verification in
  the analyze step, so "the contract the user confirmed" and "the program that
  actually executes" can never diverge.

## 2. Boundaries

The service **does**:

- `POST /v1/strategy/verify` — compile, typecheck, and `verifyStrategySemantics`
  (reverse extraction, clause-by-clause contract comparison, positive and
  negative scenarios).
- `POST /v1/backtest` — execute a program backtest and return one result shape
  with one set of metrics.
- `POST /v1/optimization/run|blind|adopt` — parameter discovery, candidate
  experiments, robustness gates, and the one-shot blind test.
- (Medium term) `POST /v1/dataset/...` — data ownership, loading Parquet
  partitions and catalogs.

The service **does not**: LLM generation, users/billing/permissions (the control
plane), trade execution, or web pages.

## 3. Reuse, with zero porting

The service lives in the same repository as the root package and imports the
existing `src/` modules directly, so **the engine does not need porting**:

| Capability | Source |
|---|---|
| AST safety + TS typecheck + transpile + hash | `src/compiler/` |
| QuickJS sandbox | `src/runtime/sandbox.ts` |
| Backtest loop | `src/runtime/backtest.ts` |
| Metrics | `src/runtime/backtest-metrics.ts` |
| Contract reverse extraction + behavioral scenarios | `src/semantics/` |
| Multi-timeframe aggregation | `src/data/aggregate-bars.ts` |
| Strategy generation / repair / versioning | `src/studio/strategy-studio.ts` |
| Parameter discovery + robustness gates + blind test | Ported from `web/worker/backtest-api.ts` into `src/optimization/` (see §7) |

Service framework: Fastify (matching the choice in `TECH_ARCHITECTURE.md` §8.1),
`tsx` in development, Node ≥22, ESM.

## 4. Shared contracts

JSON Schema plus types live in `src/contracts/` (or `packages/contracts/`), used
by both the web app and the service:

- `VerifyArtifactRequest / Response`
- `BacktestRequest` (`source` + `contract` + `bars` or `datasetRef` + `config`)
  and `BacktestResponse` (unified metrics + trades + equity + series)
- `OptimizationRequest / Response` (including robustness, blind-test state, and
  parameter versions)
- `ErrorEnvelope` (a stable `code` + `params`, following the web app's existing
  error-code convention)

## 5. Passing data (a decision point)

- **Short term**: keep the web app's existing layered candle pipeline and send
  `bars` in the request body; the service is pure computation. This is the
  smallest change and unlocks the single engine first.
- **Medium term**: data ownership moves into the service (Parquet partitions and
  catalogs in R2 or object storage), and the web app sends only a `datasetRef`
  plus a window. The backtest manifest must include the dataset digest.
- In either stage, a backtest request must carry `sourceHash` + `barsDigest`, so
  the service stays idempotent and reproducible.

## 6. Migration steps (each phase can ship independently)

### Phase 0 — lock the baseline (delivered 2026-08-04)

- **Single-engine golden baseline**, `test/engine-golden.test.ts`: 6 dimensions,
  7 cases, all pinned to the CLI sandbox — threshold/state, the 20/50 EMA trend,
  the negative-funding gate (including funding PnL), the open-interest gate,
  multi-timeframe (15m primary with a closed 1h RSI), and same-bar stop/target
  collision (deterministic stop-loss priority) plus reproducibility and
  equity-curve invariants. This is the migration's regression baseline: after
  Phases 3 and 4 change the engine, these results must stay identical.
- **Live cross-engine divergence**: not done at the unit-test level. The root
  package and `web/` are confirmed to be two isolated package environments (the
  web engine depends on `fflate` and Cloudflare types, which the root `tsc`
  cannot import; the CLI sandbox depends on `quickjs-emscripten`, which the web
  package does not have), so cross-importing in a unit test is not possible.
  Quantifying live divergence moves to **Phase 1 shadow mode** (both engines run
  side by side and are compared), which is itself more evidence that execution
  must converge into one service.
- Baseline correctness anchor: the CLI engine has been cross-validated against
  the Python reference engine trade by trade and equity point by equity point
  with zero differences, so the golden values are trustworthy.

### Phase 1 — service skeleton + backtest proxy (delivered 2026-08-04)

- [x] Create `services/backtest/`, with Fastify exposing `POST /v1/backtest`:
      `compileStrategySource` → `runBacktest` → `calculateBacktestMetrics`; and
      `POST /v1/strategy/verify` (Phase 2).
- [x] Shared contracts in `src/contracts/` (`backtest-1.0`, `verify-1.0`,
      `error-1.0`), so the service and the web app share one wire format.
- [x] Add `equityPercent` sizing to the engine: core types, sandbox, backtest,
      SDK declaration, and semantic extraction, so one engine covers every
      `sizeKind` the web contract has.
- [x] The web app's `/api/backtest/run` proxies to the service and executes the
      real program when `BACKTEST_SERVICE_URL` is set, and falls back to the old
      interpreter when it is not (a feature flag).
- [x] **Shadow mode**: with `BACKTEST_SHADOW_MODE="true"`, the old interpreter
      runs alongside, compared on tradeCount / finalEquity / netReturn thresholds
      and alerted on, without rolling back the UI.
- [x] Add `engine` to the cache key and bump it to
      `backtest-v5-engine-service`, so old and new engine results cannot collide.
- [x] The proxy path keeps the source-level `assertServiceSupported` safety net:
      when the web candles lack funding / OI / mark / turnover data, it rejects
      with the historical `OHLCV_ONLY`, so nothing is silently computed with
      zeros.
- Deployment: `npm run backtest:service` locally; Cloud Run or Fargate in
  production. Web-to-service authentication (a shared secret, or mTLS plus
  request signing) is still to do.
- Frontend field mapping: `metrics.buyAndHoldReturn` is recomputed locally by
  the web app from bars; all other metrics, trades, and the equity curve pass
  straight through.

### Phase 2 — the semantic admission gate (delivered 2026-08-04)

- [x] Service `POST /v1/strategy/verify`: compile, typecheck,
      `verifyStrategySemantics` (reverse extraction, clause-by-clause contract
      comparison, positive and negative scenarios), and a capability scan.
- [x] Web analyze calls verify for a `ready` artifact before persisting it, and
      only stores it as runnable if it passes. A compile or semantic mismatch
      returns `STRATEGY_VERIFY_FAILED` and is not stored.
- [x] Capability interception: funding / OI / mark / turnover outside
      `availableCapabilities` (the web default is OHLCV + indicators +
      multiTimeframe + state + arithmetic) is downgraded to `unsupported` during
      analyze, with the capability gap disclosed, instead of throwing an
      `OHLCV_ONLY` 500 at backtest time.
- [x] `enforceEntryConditionFloor` stays (as a supplement, not the main gate).
- [x] When the service is unreachable, analyze returns
      `STRATEGY_VERIFY_UNAVAILABLE` (503 with `Retry-After: 30`) instead of
      falling back to substring `structuralChecks` and storing the artifact. The
      old fallback would store an unverified program as `ready`: as soon as the
      model produced a different dialect (missing `id`/`version`, or calling
      `openLong()` instead of returning a decision from `onBar`), the user could
      confirm it while every backtest returned `COMPILE_FAILED`. The service is
      the only execution engine, and an unverified program cannot become runnable
      later, so an outage has to surface here. `structuralChecks` remains only
      for cases where the gate does not apply (a non-`ready` state, or no service
      configured).
- [x] The web analyze prompt inlines `STRATEGY_SDK_DECLARATION` (the same source
      as the CLI's `src/studio/prompt.ts`), with hard requirements on program
      shape and a minimal compilable example. `STRATEGY_CACHE_VERSION` moved to
      `strategy-intent-v6-sdk-declaration` accordingly, so artifacts cached under
      the old prompt are no longer reused.
- [x] `scripts/audit-strategy-sources.ts` audits historical stored artifacts:
      it compiles every `ready` source, reports the rows that cannot run, and
      archives them with `--apply`.

### Phase 3 — optimization migration (delivered 2026-08-04)

- [x] `src/optimization/`: parameter discovery and application
      (`parameter-discovery.ts`, canonical contracts with IDs identical to the
      web app's), candidate generation, trial evaluation, walk-forward /
      sensitivity / cost-pressure / market-regime / multiple-selection penalty
      gates (`optimization.ts`), and pure-computation one-shot blind testing
      (`blind-test.ts`).
- [x] **Execution switched to the real program**: `runBacktest` gained
      `evaluationStartTime` (performance-window separation — history before the
      window feeds indicator warm-up, and nothing trades or records equity before
      it), pinned by the golden tests.
- [x] **Applying parameters to the program**: `program-apply.ts` matches
      canonical rules and conditions to locate the contract-relative parameter in
      the program's AST numeric literals and rewrites the source (covering
      hoisted indicator variables, decision fields, and thresholds), so the
      baseline and every candidate are the same program family differing only in
      the tuned numbers. `applyParametersToSource` is verified against the golden
      strategies.
- [x] Service `POST /v1/optimization/run`, `/v1/optimization/blind`, and
      `/v1/optimization/materialize`; the web app proxies `optimization/run|blind`
      to the service, while `adopt` stays in the web app.
- [x] **Materializing parameter-version source**: adopt now generates real
      program source through the service's `/v1/optimization/materialize`
      (`programStatus: program-derived`), closing the earlier "blank source" gap.
- [x] D1 still owns the blind-test state machine: the atomic
      reserved→running→passed/failed claim and persistence of `blind_status` stay
      in the web app, and the service only computes and returns a receipt.
- [x] Add `engine` + `sourceHash` to the cache key and bump it to
      `optimization-v4-engine-service`; experiment IDs derive from the new key,
      so blind-test IDs cannot collide across engines.
- Performance note: every trial runs a real sandbox on the server. Twelve trials
  is roughly 30–50 inner backtests, on the order of seconds to tens of seconds.
  The async task queue is left to Phase 4.

### Phase 4 — performance and async (3–5 days)

- Compute indicator series once outside the trial loop (the web app currently
  rebuilds `IndicatorEngine` per trial, recomputing everything 50 times).
- Run the whole loop in a single sandbox eval instead of an `evalCode` per bar
  (the "one eval on a persistent runtime" direction already noted in the README),
  taking a 10k-bar single backtest from about 2s down to tens of milliseconds.
- Introduce an async task queue (Cloudflare Queues, or an in-service job store
  with polling): long backtests and optimizations return a `jobId` and the web
  app polls. The documentation already lists this gap; this fills it.

### Phase 5 — merge data ownership and clean up (2–4 days)

- The data pipeline (`src/data`) moves into the service: Parquet and catalogs in
  object storage, loaded by `datasetRef`, with the dataset digest in the backtest
  manifest.
- Delete the web engine: `IndicatorEngine`, `runContractBacktest`, the regex
  parsing, `compact`, `numberTokens`, and the rest all go, leaving a thin proxy.
- Web engine tests become contract tests against the service API, and
  `backtest-api.ts` shrinks from 2,202 lines to a few hundred.

## 7. Modules to create or port

- `src/optimization/parameter-discovery.ts` — discover tunable numeric
  parameters from the contract (or program semantics). It keeps the web app's
  `numberTokens` / `callArgumentContext` / `isLagArgument` approach, but the
  semantic skeleton uses the canonical normalization in
  `src/semantics/contract.ts`.
- `src/optimization/robustness.ts` — walk-forward, sensitivity, cost pressure,
  market regimes.
- `src/optimization/blind-test.ts` — pure-computation one-shot blind testing that
  returns an auditable receipt.
- `src/backtest-service/` — Fastify routes, auth middleware, error mapping.
- `src/contracts/` — shared schemas, types, and version numbers.

## 8. Risk and rollback

- **During migration**: shadow mode runs both and alerts when a difference
  exceeds the threshold; traffic switches once differences reach zero.
- **Idempotency**: requests carry `sourceHash` + `barsDigest`; the service is
  stateless and a repeated request returns the same result.
- **Authentication**: a shared secret plus request signing (or mTLS) between web
  and service; the service is not exposed publicly.
- **WASM**: quickjs-emscripten has no compatibility problem in a Node service, as
  it already runs under Node.
- **Blind-test single use**: the state machine (the atomic `blind_status` claim)
  stays in D1 and the service stays pure, so "executes exactly once" holds.

## 9. Milestone order

Phase 0 → 1 → 2 → 3 → 4, merged one phase at a time. Phase 5 can run in parallel
with Phase 3.
