# Strategy DSL design

English | [简体中文](STRATEGY_DSL.zh-CN.md)

> Status note: this design is no longer the only carrier of a user strategy. User
> intent is expressed by an AI-generated constrained strategy program; the types,
> data dependencies, capability tiers, state, and action model in this document
> continue as the internal IR, audit, and visualization reference. The current
> primary design is [strategy program design](STRATEGY_PROGRAM.md).

Status: Draft v0.1  
Role: the platform's most central product and technical contract  
Related: [product specification](PRODUCT_SPEC.md) | [technical architecture](TECH_ARCHITECTURE.md)

## 1. The core problem

"How does the DSL cover custom strategies?" cannot be answered by adding ever
more templates like `emaCross` and `rsiOversold`. The more templates there are,
the more rigid the combinations, until it only covers the demos.

But letting users submit arbitrary Python or JavaScript produces:

- No way to prove there is no lookahead leakage.
- Inconsistent semantics across backtest, paper, and live.
- No way to compute data dependencies and warm-up statically.
- No way to explain why a particular order was produced.
- Arbitrary network, file, clock, random number, and infinite-loop risk.
- No stable resource and permission limits on live code.

So the answer is neither "DSL only" nor "open up code", but:

> A typed declarative kernel + composable state machines + bounded formulas +
> certified sandbox plugins.

## 2. Coverage goals and honest limits

No non-Turing-complete DSL can express every possible strategy; chasing 100% of
arbitrary logic turns it into a general-purpose programming language and brings
back the safety and reproducibility problems.

The platform's goals:

- The MVP covers roughly 80% of single-instrument, bar-level, causal rule
  strategies.
- P1 covers roughly 90%, including multi-timeframe, scaled positions, and
  explicit state.
- P2 covers the remaining deterministically executable strategies through
  sandboxed plugins.
- High-frequency market making, latency arbitrage, and strategies requiring
  arbitrary external network calls are explicitly out of the core scope.

Coverage cannot ultimately be defined by feel; it has to be measured against a
corpus of real user strategies, see §16.

## 3. Three levels of customization

### Level 1: the compositional DSL

For most users:

- Choose data and indicators.
- Compose arithmetic, comparison, and boolean conditions.
- Use time semantics such as cross-timeframe, sustained satisfaction, and
  wait-after-an-event.
- Define state, transitions, order actions, and risk.

Advantages: fully explainable, plottable, backtestable, paper-runnable, and
live-runnable.

### Level 2: bounded formula features

For users whose logic is still pure computation but is not covered by the
built-in indicators:

```text
customMomentum =
  zscore(return(close, 12), 120)
  - 0.5 * zscore(funding_rate, 120)
```

Allowed:

- Mathematical operations.
- Rolling windows.
- Conditional expressions.
- Bounded state aggregation.
- Composition of registered features.

Forbidden:

- Network and file access.
- The current system time.
- Non-deterministic random numbers.
- Unbounded loops and recursion.
- Dynamically loaded code.
- Producing trading orders directly.

Formulas are parsed into the same expression AST, never executed with `eval`.

### Level 3: sandboxed plugins

For complex custom indicators, model inference, or unusual state logic.

- A plugin has an explicit input and output schema.
- It runs in an isolated WASM sandbox or an equivalent deterministic runtime.
- It has CPU, memory, execution time, and output size limits.
- It is `BACKTEST_ONLY` by default.
- Its capability can only be upgraded after causality, determinism, resource,
  paper-consistency, and security certification.

An isolated Python notebook or import can be offered during research, but Python
code never enters the live runtime directly. To go live it must be migrated into
a bounded formula, a built-in platform feature, or a certified plugin.

## 4. Seven orthogonal language layers

A strategy should not be represented as one enormous `entry` JSON. It is made of
seven layers, each responsible for one kind of semantics.

```text
1. Data Sources      where the data comes from
2. Feature Graph     how features are computed
3. Expression AST    what the conditions are
4. Temporal Logic    how a condition holds over time
5. State Machine     what state the strategy is in
6. Actions           what happens on a transition
7. Risk Envelope     the most it may do, whatever it wants to do
```

That layering is the key to covering custom strategies: new data, new indicators,
new time conditions, and new execution actions each extend independently, instead
of adding a template per complete strategy.

## 5. The data layer

### 5.1 Data references

Every data stream uses a strongly typed reference:

```json
{
  "id": "btc1h",
  "kind": "candle",
  "venue": "hyperliquid",
  "instrument": "BTC-PERP",
  "interval": "1h",
  "priceBasis": "mark"
}
```

It extends gradually:

- Candles/OHLCV.
- Trades and the L2 book.
- Mark, index, oracle, mid.
- Funding, open interest, liquidations.
- Cross-venue basis.
- On-chain data.
- External features with timestamps and version management.

### 5.2 Multiple timeframes

Multiple timeframes are not implemented by implicit resampling. Each stream
declares its own interval, with explicit alignment rules:

- Only higher-timeframe bars that have already closed may be used.
- At 10:15, a 1h strategy cannot use the complete 10:00–11:00 1h bar.
- The DSL states whether the trigger is `onClose`, `onOpen`, or a live event.

### 5.3 Declared data requirements

Compilation produces:

```json
{
  "requiredData": [
    { "kind": "candle", "interval": "15m", "lookback": 200 },
    { "kind": "candle", "interval": "4h", "lookback": 100 },
    { "kind": "funding", "lookback": 30 },
    { "kind": "open_interest", "lookback": 48 }
  ]
}
```

So the system can decide whether the data is sufficient before the backtest,
rather than failing halfway through.

## 6. The feature graph

Every indicator is a side-effect-free, versionable feature node:

```json
{
  "id": "trendStrength",
  "op": "divide",
  "args": [
    { "op": "subtract", "args": ["ema20", "ema50"] },
    "atr14"
  ]
}
```

A feature node can reference:

- Raw fields.
- Built-in indicators.
- Other feature nodes.
- Bounded formulas.
- Certified plugin outputs.

The compiler turns the feature graph into a DAG and performs:

- Topological sorting.
- Common subexpression reuse.
- Type and unit checking.
- Warm-up computation.
- Causality checking.
- Backtest/paper/live capability checking.

## 7. Types and units

Checking for `number` is not enough. The DSL needs at least these logical types:

- `Price<USD>`
- `Quantity<BTC>`
- `Notional<USD>`
- `Ratio`
- `Percent`
- `RatePer8h`
- `Duration`
- `BarCount<1h>`
- `Timestamp`
- `Boolean`
- `Side`
- `OrderType`

That prevents mistakes such as:

- Adding a price to a percentage.
- Comparing 8-hour funding as if it were an annualized rate.
- Treating 20 bars of 15m as the same span as 20 bars of 4h.
- Filling a USD notional with a BTC quantity.

Unit conversions must exist explicitly in the IR and can never be guessed by an
LLM.

## 8. The expression AST

### 8.1 Atomic expressions

```json
{ "ref": "ema20" }
{ "const": 0.05, "unit": "percent" }
{ "account": "equity" }
{ "position": "unrealizedPnlPercent" }
```

### 8.2 Arithmetic and comparison

```json
{ "op": "sub", "args": [{ "ref": "ema20" }, { "ref": "ema50" }] }
{ "op": "gt", "args": [{ "ref": "oiChange24h" }, { "const": 0.05 }] }
```

### 8.3 Boolean composition

```json
{
  "op": "all",
  "args": [
    { "op": "crossesAbove", "args": [{ "ref": "ema20" }, { "ref": "ema50" }] },
    { "op": "lt", "args": [{ "ref": "funding" }, { "const": 0 }] }
  ]
}
```

An expression AST composes better than fixed templates, and suits static
validation, visualization, and cross-language execution better than a text
formula.

## 9. Time semantics

The hard part of a trading strategy is usually not the indicator but "when does
this count as true". Time must be a first-class citizen.

Needed:

- `crossesAbove(a, b)`: the cross happens on this event.
- `rising(x, bars)`: rising consecutively or overall.
- `forBars(condition, n)`: true for n consecutive bars.
- `count(condition, window) >= n`: at least n times in a window.
- `withinBars(a, b, n)`: b happens within n bars after a.
- `since(event)`: a value or duration since an event.
- `oncePer(duration)`: rate limiting.
- `cooldownAfter(event, bars)`: a cooldown after an event.
- `atTime/session`: triggering in an explicit time zone and trading session.
- `debounce`: fire only after the signal is stable.

Example — "the 4-hour trend is up, and the 15-minute breakout happens within 8
bars after the funding rate turns negative":

```json
{
  "op": "all",
  "args": [
    { "op": "gt", "args": [{ "ref": "btc4h.ema20" }, { "ref": "btc4h.ema50" }] },
    {
      "op": "withinBars",
      "first": { "op": "crossesBelow", "args": [{ "ref": "funding" }, { "const": 0 }] },
      "then": { "op": "crossesAbove", "args": [{ "ref": "close15m" }, { "ref": "high20" }] },
      "bars": 8,
      "clock": "btc15m"
    }
  ]
}
```

## 10. An explicit state machine

Entry and exit alone cannot cover:

- A cooldown after a stop.
- Scaling in and scaling out.
- Different logic for a first breakout and a retest.
- Moving a protective stop after a profit.
- Reducing risk after consecutive losses.
- Waiting for an order to complete before the next phase.

So a strategy is fundamentally a finite state machine:

```json
{
  "initialState": "FLAT",
  "states": {
    "FLAT": {
      "transitions": [
        {
          "when": { "ref": "longSetup" },
          "actions": [
            { "type": "open", "side": "long", "size": { "ref": "riskSize" } }
          ],
          "to": "LONG_PENDING"
        }
      ]
    },
    "LONG_PENDING": {
      "transitions": [
        { "on": "order.filled", "to": "LONG" },
        { "on": "order.rejected", "to": "COOLDOWN" }
      ]
    },
    "LONG": {
      "transitions": [
        {
          "when": { "ref": "partialTakeProfit" },
          "actions": [{ "type": "reduce", "percent": 0.5 }],
          "to": "LONG_PROTECTED"
        },
        {
          "when": { "ref": "hardExit" },
          "actions": [{ "type": "close", "percent": 1 }],
          "to": "COOLDOWN"
        }
      ]
    },
    "LONG_PROTECTED": {
      "transitions": [
        {
          "when": { "ref": "trailingExit" },
          "actions": [{ "type": "close", "percent": 1 }],
          "to": "COOLDOWN"
        }
      ]
    },
    "COOLDOWN": {
      "transitions": [
        { "afterBars": 12, "to": "FLAT" }
      ]
    }
  }
}
```

States must be finite and enumerable. The MVP does not allow dynamically creating
unbounded states.

## 11. The action system

A strategy only produces order intents; it never calls an exchange.

The first actions:

- `open`
- `close`
- `reduce`
- `increase`
- `placeLimit`
- `cancel`
- `moveStop`
- `setTakeProfit`
- `setStateVar`
- `notify`

Each action has explicit preconditions and result events. `open`, for example,
may return pending, filled, partial, or rejected; the state machine must never
assume that placing an order means it filled.

Action parameters can also be expressions:

```json
{
  "type": "open",
  "side": "long",
  "size": {
    "op": "positionSizeForRisk",
    "riskPercent": 0.01,
    "entryPrice": { "ref": "markPrice" },
    "stopPrice": { "ref": "initialStop" }
  }
}
```

## 12. State variables

Beyond the finite state machine, a few typed persistent variables are needed:

```json
{
  "variables": {
    "lossStreak": { "type": "integer", "initial": 0, "min": 0, "max": 20 },
    "highestSinceEntry": { "type": "price", "initial": null },
    "entriesToday": { "type": "integer", "initial": 0, "min": 0, "max": 100 }
  }
}
```

They can only be updated through bounded reducers:

- `set`
- `increment/decrement`
- `min/max`
- `resetOn`
- `rollingAggregate`

Dynamic objects, unbounded arrays, and arbitrary memory allocation are forbidden.

## 13. The risk layer is not part of the user's strategy

A strategy may declare its intended risk, but the platform's risk envelope exists
independently and takes precedence.

```text
the executable action
  = Strategy Intent
  ∩ User Risk Policy
  ∩ Platform Risk Policy
  ∩ Venue Capability
  ∩ Jurisdiction Policy
```

So even if a user writes "go long with 100x cross leverage", the DSL can
understand that intent perfectly while compilation or live risk control still
rejects it.

Risk policy can never be overridden by a custom plugin.

## 14. The feature and plugin registry

Every built-in or plugin feature registers this metadata:

```json
{
  "featureId": "core.ema",
  "version": "1.2.0",
  "inputs": [{ "name": "source", "type": "Series<Price>" }],
  "paramsSchema": {
    "length": { "type": "integer", "minimum": 1, "maximum": 10000 }
  },
  "output": "Series<Price>",
  "causal": true,
  "deterministic": true,
  "warmup": "length - 1",
  "runtimeSupport": ["backtest", "paper", "live"],
  "implementationHash": "...",
  "testVectorVersion": "ema-v3"
}
```

The essential fields:

- Input and output types and units.
- Parameter ranges.
- The warm-up formula.
- Whether it is causal and deterministic.
- Which modes it can run in.
- Implementation version and test vectors.
- CPU and memory budget.

A plugin upgrade never silently changes an old strategy; an old strategy pins its
dependency version, and a user-initiated upgrade produces a new strategy version.

## 15. Capability tiers and live certification

Every strategy receives a capability tier at compile time:

### `BACKTEST_ONLY`

Any of:

- It uses research Python code.
- Its data is only available historically, not in real time.
- It uses non-causal features, or features whose causality cannot be proven.
- Its resource consumption is unbounded.
- A plugin is not yet certified.

### `PAPER_ELIGIBLE`

- All data is available in real time.
- Computation is deterministic and resource-bounded.
- Plugins without long-term consistency validation are allowed.

### `LIVE_ELIGIBLE`

Requires:

- Every node is causal, deterministic, and version-pinned.
- No network, file, system clock, or non-deterministic random numbers.
- Backtest replay and paper event replay produce identical results.
- Plugins pass resource and security scanning.
- The strategy's actions are supported by the venue adapter.
- Risk gating is complete.

Capability is computed only by the compiler and the certification system; neither
an LLM nor a user may declare it.

## 16. How coverage is measured

Build a corpus of real strategies rather than only the ones the team thought of.

### 16.1 The dataset

The first stage collects at least 500 user strategies covering:

- Technical indicators.
- Funding and OI.
- Multiple timeframes.
- Breakouts, retests, and mean reversion.
- Scaled entries and exits.
- Time, cooldown, and trade-count limits.
- Sizing and dynamic risk.
- Multiple instruments, spreads, and portfolios.
- External events, news, and custom models.

Each strategy is annotated by a human as:

- Directly expressible.
- Needs clarification.
- Needs a formula extension.
- Needs a plugin.
- Explicitly unsupported.

### 16.2 Metrics

- `Exact coverage`: expressible with no semantic loss.
- `Clarified coverage`: expressible after the user confirms bounded assumptions.
- `Formula coverage`: needs a bounded formula.
- `Plugin coverage`: needs a plugin.
- `Unsupported rate`.
- `Silent semantic loss`: the system claimed success but changed what the
  strategy means. This must be near zero.
- `Round-trip agreement`: after the DSL is re-explained in natural language, the
  user confirms the meaning matches.

### 16.3 Launch bar

- `Exact + Clarified coverage >= 80%` for core target users' strategies.
- `Silent semantic loss < 1%`, with zero high-risk divergences.
- Everything inexpressible comes with a structured reason, never a fabricated
  approximation.
- Every new operator adds golden examples, counter-examples, and cross-runtime
  consistency tests.

## 17. The natural-language compilation pipeline

```text
Natural language
  -> Intent extraction
  -> Ambiguity detection
  -> Clarification contract
  -> Candidate typed AST
  -> Schema validation
  -> Semantic and unit validation
  -> Causality and data validation
  -> Capability classification
  -> Canonical IR
```

The LLM participates only in the first four steps. Everything after is a
deterministic compiler.

### 17.1 The clarification contract

The user writes: "Go long on a breakout with high volume, exit when the trend
breaks."

The system must not choose the parameters itself; it returns:

```json
{
  "ambiguities": [
    {
      "id": "volume_definition",
      "question": "How should high volume be measured?",
      "options": [
        "volume > 1.5 × 20-bar average",
        "volume z-score > 2 over 100 bars"
      ]
    },
    {
      "id": "breakout_level",
      "question": "What price level defines the breakout?",
      "options": ["20-bar high", "50-bar high", "custom"]
    },
    {
      "id": "trend_exit",
      "question": "What defines the trend break?",
      "options": ["close below EMA50", "close below latest swing low", "custom"]
    }
  ]
}
```

Each assumption enters the strategy version only after the user confirms it.

### 17.2 The reverse explanation

After compilation, the explanation is generated from the DSL rather than from the
original input:

> On every completed 1-hour BTC bar, open a long position only when...

What the user confirms is the logic that will actually execute, which prevents an
invisible gap between "the model understood" and "the system executed".

## 18. Multiple languages and visualization

The DSL contains no natural-language copy of its own. Chinese, English, and every
other language compile to the same AST.

Because every node has types and metadata, one DSL can generate:

- A natural-language description.
- A rule tree.
- A data dependency graph.
- Signal markers on charts.
- A risk summary.
- A version diff.
- An audit explanation.

That is a major product reason for choosing a structured DSL over storing a blob
of generated code.

## 19. Versioning and compatibility

A strategy's identity includes:

- The DSL schema version.
- Each feature and operator version.
- The compiler version.
- The canonical IR hash.
- The data schema and version.
- The runtime engine version.

Rules:

- An old version keeps its original semantics.
- A breaking semantic change must bump the major version.
- Automatic migration can only produce a new draft; it never overwrites a running
  version.
- A live strategy pins its IR hash, and any change requires re-backtesting and
  re-approval.

## 20. Language scope by phase

### MVP

- One venue, one instrument.
- A single primary clock that may reference closed higher-timeframe data.
- Built-in technical indicators, funding, and OI.
- Arithmetic, comparison, boolean, and basic time operators.
- Standard flat/pending/long/short/cooldown states.
- A single position, take profit and stop loss, trailing stops, and fixed or
  risk-percentage sizing.
- No user code.

### P1

- The full explicit state machine.
- Scaled entries and exits.
- Bounded state variables.
- Bounded formula features.
- Multi-timeframe and limited multi-instrument references.
- A research/paper plugin sandbox.

### P2

- Certified WASM plugins.
- Multi-asset, spread, and portfolio-level state.
- Time versioning and availability proofs for external features.
- Creator-shared feature packs.
- Richer orders and venue capability negotiation.

### Permanently excluded

- Arbitrary user code entering the live runtime directly.
- Unreplayable external signals going live directly.
- Self-modifying strategies bypassing versioning and re-approval.
- Plugins reaching the wallet, keys, or the execution service.
- Unbounded resources and sub-millisecond high-frequency strategies.

## 21. The product experience that matters most

Users should not feel they are learning a DSL. The normal flow is:

1. The user describes the strategy in natural language.
2. The system asks only about things that change what the strategy trades.
3. The page shows the visualized rules and the key assumptions.
4. The user can edit any node by conversation or by form.
5. The system states clearly whether the strategy is backtest, paper, or live
   eligible.
6. Advanced users can expand the DSL, the formulas, and the version diff.

The DSL is the platform's internal trust contract, not an interface that forces
ordinary users to program.

## 22. Current architectural decisions

1. Fixed strategy templates are not the core abstraction.
2. An LLM does not generate arbitrary code that is then executed directly.
3. Use a typed expression AST and explicit time operators.
4. Use a finite state machine for path-dependent strategies.
5. Use a feature registry to extend indicators and data.
6. Use capability tiers to separate research, paper, and live.
7. Keep measuring coverage against a corpus of real user strategies.
