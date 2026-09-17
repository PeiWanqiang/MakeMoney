# The generalization architecture plan

English | [简体中文](GENERALIZATION_ARCHITECTURE_PLAN.zh-CN.md)

Status: in progress  
Scope: natural-language intents, strategy contracts, the compiler, the runtime,
the backtest service, the web app, data, caching, optimization, paper, live,
tests, and documentation.  
Acceptance policy: [GENERALIZATION_POLICY.md](GENERALIZATION_POLICY.md)

## 1. The general capability

The platform compiles any supported single-instrument, causal, event-driven
trading intent into one versioned semantic artifact. That artifact must determine
all of: data requirements, computed expressions, time semantics, state
transitions, trading actions, risk intent, and which modes it may run in. The
product explanation, backtesting, optimization, paper, and live may only consume
that artifact — none of them may re-interpret natural language or maintain an
approximation of the semantics.

This definition is not scoped to a user's sentence, instrument, timeframe,
indicator, direction, language, or example constant. A capability that cannot
enter the versioned semantic artifact and execute deterministically stays
`unsupported`.

## 2. The current baseline and the problems to solve

Reliable foundations to keep:

- Constrained TypeScript, AST safety checks, and full TypeScript typechecking.
- QuickJS/WASM isolation, resource limits, and structured decision validation.
- Deterministic bar backtesting, next-bar-open fills, and the closed-bar rule
  across timeframes.
- Dataset hashes, Parquet partitions, and basic cross-validation against an
  independent reference engine.

Architectural shapes that need replacing:

- The model generates both TypeScript and a string-condition contract, creating
  two sources of truth.
- The web app and the Node service each interpret part of the strategy and
  optimization semantics.
- Capability enumerations, indicator lists, timeframes, output schemas, and
  validation rules are copied in several places.
- Strategy versions and caches are not bound to the SDK ABI, the runtime, the
  data manifest, and the full program identity.
- Unit tests cover many local implementations but there is no cross-layer
  capability consistency gate.

## 3. Target architecture

```text
natural language
  -> IntentResult (ready / needs_clarification / unsupported)
  -> StrategySemanticIR v2
  -> deterministic compiler
       -> constrained TypeScript program
       -> CapabilityManifest
       -> DataRequirements
       -> ExplanationModel
       -> ParameterSchema
  -> StrategyArtifactManifest
  -> one event kernel
       -> backtest adapter
       -> recorded replay / paper adapter
       -> live adapter
  -> independent risk engine
  -> order intent / audit events
```

### 3.1 `StrategySemanticIR v2`

The IR is the typed semantics shared by the model's intent, the compiler's
reverse extraction, and the product explanation. It stops embedding a free-text
language inside `when: string[]`.

It contains at least:

- `schedule` — triggering event, primary timeframe, closed-bar rule, time zone,
  and session.
- `data` — venue, instrument, fields, price basis, lookback, alignment, and
  missing-data policy.
- `features` — a versioned feature DAG, its parameters, output types, units, and
  warm-up.
- `expressions` — the AST for numeric, comparison, boolean, and bounded time
  expressions.
- `state` — keys, types, initial values, and read and write effects.
- `actions` — versioned actions such as open, close, reduce, increase, moveStop.
- `riskIntent` — the position and stop semantics the strategy requests; the
  platform's risk ceiling stays separate from it.
- `modeEligibility` — BACKTEST_ONLY, PAPER_ELIGIBLE, LIVE_ELIGIBLE, with reasons.
- `unsupported` — the missing reusable primitive and an explicit rejection
  reason.

The IR the model generates and the IR the compiler derives from the program use
the same schema and are compared structurally. An advanced program that cannot be
reverse-extracted may not pose as a fully explainable strategy; it either enters a
restricted capability tier or is rejected.

### 3.2 Capability registry

Each capability is registered exactly once, and its entry carries:

- A stable ID and a version.
- Input and output types with units.
- Data dependencies and warm-up computation.
- The SDK declaration and the runtime implementation.
- IR compile and reverse-extraction handlers.
- UI labels and the explanation projection.
- Whether the optimizer may expose its parameters.
- The backtest/paper/live capability tier.
- Its original regression, parameter variant, structural variant, and boundary
  test sets.

The SDK declaration, the capabilities offered to the model, the JSON Schema, the
UI capability table, and the test matrix are all derived from the registry.
Hand-writing several copies of an enumeration is no longer allowed.

### 3.3 Strategy artifact manifest

Every runnable version must store:

- `semanticIrVersion`, `semanticHash`.
- `source`, `programHash`, `compilerVersion`.
- `sdkAbiHash`, `runtimeVersion`, `capabilityVersions`.
- `dataRequirementsHash`, `modeEligibility`.
- Parent version, provenance, user confirmation, and migration origin.

The identity key of a backtest result must be determined jointly by:

```text
artifactManifestHash
+ datasetManifestHash
+ backtestConfigHash
+ executionPolicyVersion
```

A contract alone, a prompt version, or a hand-written engine string may never
stand in for execution semantics.

### 3.4 One execution kernel

- The web app only does identity, permissions, confirmation, job orchestration,
  and presentation.
- The strategy service owns generation, compilation, verification, version
  materialization, and capability decisions.
- The backtest service owns data resolution and the one event kernel.
- The web app keeps no contract backtester, no indicator implementation, and no
  local optimization fallback.
- When a service is unavailable, fail closed; never create a `ready` version with
  empty source.
- Backtest, replay/paper, and live share the same strategy invocation, state
  commit, risk engine, and order-intent rules, swapping only the event source and
  the fill adapter.

### 3.5 Data semantics

- Callers pass a `datasetRef`; a bag of bars with undeclared capabilities is
  never treated as complete data semantics.
- The dataset manifest declares fields, units, provenance, time coverage,
  alignment, gaps, and hashes.
- The `DataRequirements` produced by compilation are matched deterministically
  against the dataset manifest before execution.
- Fallbacks such as `markPrice -> close` or treating missing funding as zero must
  become explicit, versioned execution policy; by default, a missing critical
  field rejects execution.

## 4. Phased implementation

### Phase 0: stop the bleeding and establish shared boundaries (starting now)

Goal: stop producing more cross-layer drift, and establish a trustworthy boundary
for the IR v2 migration.

- [x] Model artifacts, verify, and optimization share one runtime
      `StrategyContract v1` parser.
- [x] The model output schema and parser cover `equityPercent` and
      expression-valued risk fields.
- [x] The web backtest cache binds to the digest of the source actually stored,
      and the cache version was bumped.
- [x] The backtest service validates the wire schemaVersion, the compiled
      sourceHash, market ordering and OHLC bounds, and configuration ranges.
- [x] Verify, optimization, blind, and materialize each validate their wire
      schemaVersion and the full strategy contract.
- [ ] Result artifacts gain a unified execution manifest, and caching switches to
      the manifest hash.
- [ ] With no service configured, forbid creating new `ready` versions,
      backtests, optimizations, and empty-source versions.
- [ ] Before deleting the old path, complete the historical artifact audit, the
      migration inventory, and a read-only compatibility policy.

Exit bar: cross-layer capability consistency tests cover all three sizing modes,
constant and expression risk fields, partial close, illegal versions, mismatched
source hashes, and out-of-order or illegal bars; the full root and web
regressions pass.

### Phase 1: a minimal vertical slice of `StrategySemanticIR v2`

Migrate one complete but non-example-specific capability set first:

- OHLCV and indicator data references.
- Numeric arithmetic and units.
- Comparison, AND/OR/NOT, and cross.
- open / close / partial close.
- One explicit state key with a state write effect.
- Constant, equity-percent, and risk-percent sizing, and computed stops.
- Single-timeframe reads and closed higher-timeframe reads.

Work items:

1. Define the JSON Schema and a runtime validator, and generate TypeScript types
   from the schema.
2. The model generates the IR first; deterministic lowering produces TypeScript
   for common strategies.
3. The compiler produces the same IR from TypeScript, and structural comparison
   replaces canonical string comparison.
4. Explanation and parameter schema switch to consuming the IR.
5. v1 contracts go behind an explicit read-only adapter; historical artifacts
   that cannot be proven equivalent are never silently upgraded.

Exit bar: every migrated capability passes the same capability matrix across
intent, IR, program, explanation, backtest, persistence, and caching; v1 and v2
results never share a cache key.

### Phase 2: converge the control plane and the execution plane

1. Web analyze calls the strategy service, and its separate SYSTEM_PROMPT, output
   parsing, and repair loop are deleted.
2. Web backtest and optimization must call the service;
   `IndicatorEngine`, `runContractBacktest`, and the string parameter interpreter
   are deleted.
3. Data ownership moves into the backtest service; the web app passes only a
   datasetRef and a window.
4. Jobs become asynchronous: idempotent, with quotas, cancellation, retries,
   progress, and immutable receipts.
5. D1/PostgreSQL store explicit version columns; large artifacts go to object
   storage with the database holding manifests and references.

Exit bar: the production path has no second executor and no unverified fallback;
the same artifact, dataset, and config produce the same result identity and the
same per-event output in the CLI, the API, and the web app.

### Phase 3: one replay/paper kernel

1. Define immutable market, timer, order, fill, position, and risk event
   envelopes.
2. Backtest becomes an event-source adapter, without changing strategy or
   state-commit logic.
3. Implement recorded-event replay and a paper adapter.
4. The risk engine returns approved / reduced / rejected for a requested
   position, instead of silently truncating inside the backtest.
5. Compare backtest and paper on the same recorded data, signal by signal, order
   intent by order intent, state commit by state commit.

Exit bar: deterministic replay with zero differences, plus boundary tests for
restarts, duplicate events, reconnect backfill, and state recovery.

### Phase 4: live admission and capability expansion

Only capabilities the registry marks LIVE_ELIGIBLE reach live trading. Adding any
new indicator, time logic, action, or data source requires all of:

- A general capability definition.
- Types, units, data, and timing.
- Compile, reverse-extraction, and runtime implementations.
- Backtest/paper consistency evidence.
- Explanation, version, cache, and documentation changes.
- Regression, parameter variant, structural variant, boundary rejection, and
  existing regression coverage.

## 5. Migration and compatibility principles

- A v1 artifact is never overwritten in place; migration creates a new version and
  keeps the parent hash.
- v1 rules that can be proven structurally equivalent can be migrated
  deterministically; the rest stay read-only or are re-confirmed.
- A historical backtest receipt is always displayed under its original engine,
  SDK, and data versions. It is never recomputed under new semantics and passed
  off as the original result.
- During migration, shadow mode exists only to observe differences. It is never a
  user-facing execution fallback.
- After each phase completes, delete the old implementations and tests that no
  longer have callers. Two stacks are not maintained long-term.

## 6. Test and evaluation gates

Three complementary gates:

1. **The capability matrix** — every registry capability is verified across
   intent, IR, program, execution, explanation, and persistence.
2. **Metamorphic and property tests** — renaming variables, equivalent
   parentheses, condition order, numeric variants, and changes of direction,
   timeframe, or language must not change unrelated semantics.
3. **Real frozen evaluations** — development, validation, and blind sets built
   from two independent human reviews with adjudication; fixed regressions and
   blind runs are reported separately.

High-risk semantics additionally require hand-computed small datasets, an
independent reference implementation, and backtest/paper consistency on recorded
replays.

## 7. Layers this first change touches

Phase 0 applies to:

- Intent: the model output schema and parsing capability move together.
- Contract and types: one unified v1 runtime parser.
- Compile and validate: sourceHash is determined by the service's compilation
  result.
- Execution: existing fill semantics are unchanged; only illegal input is
  rejected.
- Product: backtest receipts record the source digest; the user-facing
  explanation is unchanged for now.
- Data and cache: caching binds to the source, and illegal or out-of-order bars
  are rejected.
- Documentation: this plan records the capability boundaries and the migration
  ahead.

This round explicitly does not claim: IR v2, a single web executor, backtest/paper
consistency, or enforced dataset-manifest matching. Those stay as explicit gates
for later releases.
