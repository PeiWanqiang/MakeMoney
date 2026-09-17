# Strategy program design

English | [简体中文](STRATEGY_PROGRAM.zh-CN.md)

Status: Implemented local product slice v0.3
Core choice: the model generates constrained TypeScript; the platform compiles
it, audits it, and runs it in a QuickJS/WASM sandbox

## 1. Why we moved from a DSL to programs

Trading strategies naturally contain conditions, local variables, history
windows, state, and non-trivial control flow. Extending a JSON DSL far enough
ends in reinventing an underpowered programming language.

The current approach is:

```text
user's natural language
  -> the model generates a machine semantic contract and a TypeScript program together
  -> AST static safety checks
  -> TypeScript compilation
  -> semantics extracted back out of the program and compared clause by clause with the contract
  -> automatically generated positive cases, per-condition negative cases, and mutation tests
  -> content hash and capability analysis
  -> QuickJS/WASM sandbox
  -> structured order intent
  -> independent risk engine
```

Programs solve expressiveness, the SDK and the sandbox solve control, and a
separate risk layer solves "even a program that expresses itself perfectly still
cannot place arbitrary orders".

## 2. What a user program looks like

```ts
defineStrategy({
  id: "example.ema-funding",
  name: "EMA crossover with negative funding",
  version: 1,

  onBar(ctx) {
    const fast = ctx.indicators.ema("close", 20);
    const fastPrevious = ctx.indicators.ema("close", 20, 1);
    const slow = ctx.indicators.ema("close", 50);
    const slowPrevious = ctx.indicators.ema("close", 50, 1);

    if (
      ctx.position.side === "flat" &&
      ctx.market.fundingRate < 0 &&
      ctx.crossedAbove(fast, fastPrevious, slow, slowPrevious)
    ) {
      return {
        type: "open",
        side: "long",
        size: { kind: "riskPercent", value: 0.01 },
        stopLossPercent: 0.02,
        takeProfitRiskReward: 2,
        reason: "EMA crossover with negative funding"
      };
    }

    return { type: "hold" };
  }
});
```

An ordinary user never has to look at the code. The product shows a
natural-language explanation, the key conditions, the risks, and the backtest
results. Advanced users can expand, edit, and fork the program.

## 3. The Strategy SDK is the product boundary

A program cannot reach an exchange. The platform provides only a versioned
`ctx`:

- `ctx.market` — market events that have already happened.
- `ctx.indicators` — deterministic indicators and history windows.
- `ctx.history` — bounded OHLCV, mark, funding, and OI arrays and bar windows.
- `ctx.timeframe("1h")` — read another timeframe's *closed* market, indicators,
  and history; a higher-timeframe bar that has not closed is never exposed.
- `ctx.position` — a read-only position snapshot.
- `ctx.account` — read-only account equity.
- `ctx.state.get/set` — explicit, JSON-serializable persistent state.
- `ctx.crossedAbove/Below` — general helpers.

A program can only return a structured decision:

- `hold`
- `open`
- `close`
- later, `reduce`, `increase`, `moveStop`, and others

The runtime converts a decision into an order intent. The risk engine can reject
or shrink it, and the program holds no trading credentials.

## 4. Why not just execute ordinary code

Ordinary code has far too much capability by default. The compiler currently
rejects:

- `import` and dynamic import.
- `fetch`, WebSocket, and any network access.
- `process`, `require`, and the Node runtime.
- `Date`, `performance`, and any non-deterministic clock.
- `eval`, `Function`, and dynamic code generation.
- `new`, prototype access, and constructor access.
- Loops and unbounded computation; the first version forbids loops entirely.
- Arbitrary member assignment; persistent state goes only through
  `ctx.state.set`.

The runtime adds a second layer:

- QuickJS runs inside a WebAssembly isolate.
- A CPU time limit per call.
- A memory limit per call.
- No file, network, process, wallet, or exchange object is injected.
- Output must pass runtime schema validation.

Static checks exist to produce clear errors. The sandbox and the resource limits
are the actual execution security boundary.

## 5. Determinism and versioning

Every compiled program has a SHA-256 hash. A backtest record pins at least:

- The original strategy version.
- The compiled program hash.
- The Strategy SDK version.
- The runtime version.
- The data snapshot hash.
- Fee, slippage, and funding configuration.

The same program, the same data snapshot, and the same configuration must produce
the same decisions, orders, and results.

The current bar runtime:

- Runs the strategy on bars that have already closed.
- Produces a decision at that bar's close.
- Executes at the next bar's open.
- Conservatively assumes the stop happened first when a stop and a target trigger
  on the same bar.
- Accounts for funding, fees, and slippage explicitly.

## 6. Stateful strategies

A program can naturally express path dependence that a DSL struggles with:

```ts
const losses = ctx.state.get("consecutiveLosses", 0);

if (losses >= 3) {
  return { type: "hold", reason: "cooldown after three losses" };
}
```

Persistent state must:

- Be read and written through an explicit API.
- Contain only JSON values.
- Be saved after every event.
- Mean the same thing in backtest, paper, and live.
- Have a size and update-frequency ceiling.

Restricted event entry points can be added later — `onOrderUpdate`,
`onPositionUpdate`, `onTimer` — but each stays a deterministic event handler.

## 7. The new role of the internal IR

A program no longer has to be translated fully into a JSON DSL. The internal IR
extracts only what the platform must understand:

- Data dependencies and warm-up.
- Which SDK capabilities are used.
- Which order-intent types can be produced.
- State keys and their types.
- The backtest/paper/live capability tier.
- Risk declarations.
- The program hash and version.

Anything that cannot be extracted statically can be supplemented with runtime
evidence, but never as a way around the risk layer.

## 8. The AI generation and repair loop

```text
user intent
  -> the model generates a candidate program plus an independent machine semantic contract
  -> the compiler returns structured errors
  -> the model repairs only the failing locations
  -> rules are extracted back out of the program and compared clause by clause with the contract
  -> the contract generates positive cases and per-condition negative cases automatically
  -> mutation testing confirms that a wrong timeframe, direction, size, or stop is rejected
  -> the user-facing explanation is generated from the verified contract
  -> the user confirms
```

The model is given:

- The complete SDK type declarations.
- Runnable examples.
- The list of forbidden capabilities.
- The target runtime version.
- Structured compiler errors.

The model may never quietly change what a strategy means in response to a
failure. When information is missing or ambiguous it must return
`needs_clarification` with a specific question; when the intent is clear but the
current SDK cannot express it, it must return `unsupported` with the missing
capability, never a "closest available" substitute. Any semantic change must
appear in the diff and in the reverse explanation.

## 9. Current code layout

```text
src/
  compiler/
    validate-strategy-source.ts  # AST strategy and safety checks
    compile-strategy-source.ts   # TS compilation, normalization, SHA-256
  runtime/
    sandbox.ts                   # isolated QuickJS/WASM execution
    backtest.ts                  # deterministic bar-level backtesting
  semantics/
    contract.ts                  # the machine semantic contract
    extract-semantics.ts         # extracting trading rules back out of a program
    scenario-runner.ts           # contract-driven positive and negative scenarios
    mutation-testing.ts          # fault injection on timeframe/direction/size/stop
    golden-cases.ts              # 20 strategies, 100 synthetic phrasings
  core/types.ts                  # decisions, positions, fills, and results
  strategy-sdk.ts                # the program interface given to the model and the editor
examples/
  strategies.ts                  # golden strategy programs
  run-demo.ts                    # end-to-end example
test/
  source-validation.test.ts
  sandbox.test.ts
  backtest.test.ts
```

## 10. Implemented today

- DeepSeek V4 Pro as the default provider, with the OpenAI Responses API as a
  fallback provider.
- Three product actions — `ready`, `needs_clarification`, `unsupported` — with
  separate fields for the follow-up question and the capability rejection.
- Natural-language generation, structured compile diagnostics, and at most two
  rounds of targeted repair.
- Full TypeScript semantic typechecking, which stops the model from inventing SDK
  methods.
- Reverse explanation, assumptions, warnings, a change summary, and a source
  diff.
- Immutable strategy session versions, plus optional real-data backtest
  artifacts.
- A single `defineStrategy` program entry point.
- TypeScript AST parsing and forbidden-capability checks.
- TypeScript to JavaScript compilation.
- SHA-256 program versions.
- QuickJS/WASM execution with memory and time limits.
- OHLCV, funding, and OI context.
- SMA, EMA, highest, lowest, percentChange, standardDeviation, RSI, ATR, MACD,
  and Bollinger Bands.
- Bounded history arrays and bar windows.
- Multi-timeframe reads across 1m, 15m, 1h, and 4h, enforcing the closed-bar rule
  against lookahead.
- The model's semantic contract, reverse semantic extraction from the program, and
  rule-by-rule comparison.
- Contract-driven positive and negative scenario verification plus automatic
  mutation testing.
- 20 golden semantic strategies, 100 synthetic phrasings, 123 scenarios, and 100
  must-kill mutations.
- Real DeepSeek smoke tests covering RSI, EMA+ATR, and a 15m check against a
  closed 1h signal; all three passed the full semantic gate with zero repairs.
- Real batched DeepSeek evaluation with content fingerprints, resumption,
  concurrency, token/latency/cost records, and offline semantic recomputation; the
  full-set result improved from V2's 86/100 and V3's 94/100 to V4's 100/100.
- Of V4's full 100, 21 went through automatic repair, with 0 contract mismatches,
  0 generation errors, and 0 provider errors. That result represents a fixed
  synthetic regression set, not real-user accuracy.
- The contract comparator normalizes whitespace, common cross spellings,
  multi-timeframe cross spellings, and the equivalent left/right swap of a
  relational comparison, so `close < lower` and `lower > close` are not reported
  as different strategies.
- Explicit persistent state.
- Validation of hold/open/close decisions.
- Fills at the next bar's open.
- Position sizing, stops and targets, funding, fees, and slippage.
- Deterministic regressions and initial sandbox-escape tests.

## 11. Next

Full progress and priorities live in
[project status and next steps](PROJECT_STATUS.md). On the strategy-program side,
what remains is:

1. Stop tuning against the fixed synthetic set. Build a frozen evaluation set with
   provenance from clearly licensed public internet phrasings, and measure
   semantic preservation, clarification rate, repair rate, latency, cost, and
   repeated-run stability.
2. Extend the current rule extraction into full SDK capability, data dependency,
   and warm-up analysis.
3. Add reduce, increase, and moveStop actions.
4. Give the golden strategies fixed market data, program hashes, and full
   backtest results, and add state and boundary cases.
5. Wrap the local CLI slice into a minimal web conversation experience.
6. Verify that backtest replay and the paper runtime agree on the same recorded
   data.

## 12. Safety principles that never change

However expressive programs become, these capabilities are never handed to a user
program:

- Wallet keys.
- An exchange API client.
- Any order path that bypasses the risk engine.
- Transfers and withdrawals.
- Arbitrary network or file access.
- Modifying its own code or its runtime version.
- Modifying platform-level risk parameters.
