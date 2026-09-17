# Generalization-first acceptance policy

English | [简体中文](GENERALIZATION_POLICY.zh-CN.md)

Status: mandatory, project-wide  
Scope: product, user research, business experiments, natural-language intents,
prompts, strategy contracts, the Strategy SDK, the compiler, the validator, the
runtime, backtesting, paper trading, live trading, the frontend, data, caching,
tests, and documentation.

## 1. The core rule

A user's example is evidence of a requirement and a regression case. It is never
the boundary of the implementation. What gets implemented is the reusable
semantic primitive behind the example.

Forbidden:

- Special-casing a user's exact sentence, a keyword combination, or one
  particular model output.
- Hard-coding a number, instrument, market, direction, timeframe, or language
  taken from an example.
- Changing only the prompt so the model claims to "support" something the
  contract and the executor cannot deterministically execute.
- Implementing separate approximations that mean different things in backtest,
  paper, and live.
- Declaring a capability finished because the original example passes.
- Tuning logic to clear a fixed evaluation set without testing unseen variants.

Required:

- Generalize the requirement into a semantic capability that is independent of
  the example's constants.
- Define inputs, outputs, units, boundaries, errors, and execution timing.
- Express it through versioned types or contracts, never free text standing in
  for runtime semantics.
- Keep it consistent across every layer that actually consumes the semantics.
- When it cannot be generalized safely, keep it `unsupported` and record the
  missing reusable primitive.

## 2. Implementation path

Before starting a capability, write one sentence defining it without reference to
the example. For instance:

> Wrong: support "BTC 4h, a 50% retracement from the highest high of the last
> 100 bars".  
> Right: numeric market and indicator expressions support bounded arithmetic and
> parentheses; position sizing supports notional as a fraction of account equity.

Then check layer by layer:

1. **Intent** — different languages and phrasings map to the same semantics, and
   ambiguity must trigger a clarifying question.
2. **Contract and types** — explicit fields, units, ranges, and a version;
   execution never depends on interpreting natural language.
3. **Compile and validate** — accept every legal combination; reject illegal
   values, dangerous capabilities, and unsupported combinations.
4. **Execution** — backtest, paper, and live use one semantic definition and one
   timing model, with no silent approximation.
5. **Product** — the summary, contract, charts, and trade records the user sees
   match what actually executed.
6. **Data and caching** — version keys change when a capability or its semantics
   change, so results computed under old semantics are never reused.
7. **Documentation** — the capability table describes general boundaries, and a
   single example is never written up as a product capability.

Not every change touches all seven layers, but which layers apply must be stated
explicitly, and no layer that actually consumes the capability may be skipped.

## 3. Test acceptance bar

A feature is complete only with at least this evidence:

1. **Original regression** — the user's reported example passes end to end.
2. **Parameter variant** — key numbers changed, proving no constant is baked in.
3. **Structural variant** — at least one relevant dimension changed among
   operator, direction, indicator, position type, timeframe, or language.
4. **Boundary or rejection** — illegal ranges, division by zero, missing
   conditions, lookahead, and unsupported capabilities are explicitly blocked.
5. **Semantic consistency** — the machine contract, the user-facing explanation,
   and the actual trading behavior agree.
6. **Existing regression** — the existing test suite still passes.

High-risk trading semantics additionally require:

- A small deterministic dataset computed by hand.
- Cross-validation against an independent reference implementation or a recorded
  event replay.
- A same-input consistency test between backtest and paper/live.

## 4. Guarding evaluations against overfitting

- The development split is for diagnosing problems. Frozen test and blind splits
  must never participate in prompt or rule tuning.
- Every fix adds unseen phrasings and combination variants, not just the original
  example.
- Reports present fixed regressions, real user phrasings, blind runs, and
  repeated-run stability separately.
- A perfect score from one model, one run, or one fixed synthetic set is never
  reported as product accuracy.
- Constants that appear in test cases must not appear in production branching,
  unless they are an explicit risk limit or a protocol standard.

## 5. Generalization in product and business

- One user's feedback is evidence of a problem, not a conclusion about the
  market.
- Turn feedback into a falsifiable hypothesis and test it across different users,
  languages, strategy types, and stages of use.
- Pricing, plans, copy, acquisition channels, and flows are never tailored to a
  single test user, unless explicitly recorded as a time-boxed manual-service
  experiment.
- Business conclusions must distinguish a single case, a pattern shared by a
  segment, and evidence of a scalable market.
- Compliance, regional, and venue exceptions are modeled explicitly. Real legal
  boundaries are never flattened for the appearance of generality.

## 6. Change acceptance checklist

Confirm each item before merging or releasing:

- [ ] The capability definition contains no incidental constant from the original
      example.
- [ ] No special-case branch on a user's sentence, a single instrument,
      timeframe, direction, or language.
- [ ] The semantics the model generates can be consumed by a deterministic
      contract and executor.
- [ ] Every applicable layer uses the same meaning and the same units.
- [ ] Cache, artifact, or engine versions were bumped where semantics changed.
- [ ] Original example, parameter variant, structural variant, and boundary tests
      are all covered.
- [ ] The explanation shown to the user matches what execution actually did.
- [ ] Documentation records the general capability and its real boundaries.

If any item fails, the capability may not be marked complete or supported.
