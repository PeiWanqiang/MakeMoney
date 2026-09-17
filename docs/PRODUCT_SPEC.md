# Product specification: Crypto Strategy Studio

English | [简体中文](PRODUCT_SPEC.zh-CN.md)

Status: Draft v0.1  
Target market: international crypto traders  
Launch language: English  
Launch venue: Hyperliquid  
Launch instruments: BTC, ETH, SOL perpetuals

## 1. What this is

### 1.1 One line

Turn any crypto trading idea into a strategy you can verify, simulate, and run.

It converts a trading idea described in natural language into a deterministic
strategy, with trustworthy backtesting, live paper trading, and controlled live
execution.

### 1.2 What it is not

- Not an AI signal group.
- Not an automated trading bot that guarantees returns.
- Not a large model freely deciding each trade from the news.
- Not a quant platform covering every exchange and asset class on day one.
- Not a wallet or exchange that holds user funds.

### 1.3 Core value

Traders usually hit four breaks: they have an idea but cannot code; they can
backtest but do not trust the result; getting a strategy live is hard; and once
live there is no risk control or review. The platform connects those four into
one auditable path.

### 1.4 Product promises

- From idea to a first valid backtest in under 5 minutes.
- Every backtest result shows its costs, assumptions, data range, and
  limitations.
- One strategy keeps the same semantics across backtest, paper, and live.
- The user can explain why the strategy produced every order intent.
- If the AI service fails, a running strategy does not change its logic or lose
  its risk controls.

## 2. Target users

### 2.1 Primary: experienced discretionary traders

Traits:

- Already trading BTC, ETH, or SOL perpetuals.
- Able to describe their entry, exit, and risk rules.
- Not fluent in Python, Pine Script, or a full quant workflow.
- Willing to pay to save research and monitoring time.

Core job: turn personal experience into a verifiable, repeatable strategy.

### 2.2 Secondary: trading content creators

Traits:

- Publish trading views on X, YouTube, Discord, or Telegram.
- Want to build credibility with a transparent record.
- Want to publish, iterate on, and monetize their strategies.

Core job: turn a view into a versioned, recorded, followable strategy asset.

### 2.3 Later: semi-professional quants

Traits:

- Already write code but want fast strategy prototypes.
- Need more reliable data, hosted execution, and cross-venue capability.

Core job: shorten the cycle from research to deployment.

### 2.4 Not actively served yet

- Beginners who do not understand leverage and liquidation.
- Signal seekers who only want to know "what do I buy today".
- High-frequency market-making, arbitrage, and millisecond execution teams.
- Fund clients needing institutional portfolios, compliance reporting, and
  multi-person approvals.

## 3. The core product loop

Capability expansion follows the
[generalization-first acceptance policy](GENERALIZATION_POLICY.md): a user's
example is used to discover a general semantic gap and to build regression
evidence, never as a special implementation branch. The product may only show
"supported" when the intent, contract, execution, and user-facing explanation
agree and the variant and boundary tests pass.

```text
describe the idea
  -> the model clarifies what is not yet quantifiable
  -> generate the strategy
  -> backtest and find the problems
  -> revise or fork
  -> deploy to paper
  -> accumulate real running evidence
  -> share, subscribe, or go to controlled live
  -> keep improving from the divergence
```

The platform's growth loop is not about encouraging more orders; it is about
creating, verifying, sharing, and reusing good strategies.

## 4. Strategy lifecycle

```text
Draft
  -> Validated
  -> Backtested
  -> Paper Running
  -> Live Eligible
  -> Live Running
  -> Paused
  -> Archived
```

Key gates:

- `Validated`: the DSL structure, indicator dependencies, timeframe, and risk
  fields are all valid.
- `Backtested`: at least one backtest including fees and funding is complete.
- `Paper Running`: bound to live market data and running on virtual capital.
- `Live Eligible`: it passes the platform's baseline risk checks and the user has
  completed risk acknowledgment.
- `Live Running`: wallet authorization is valid, and the execution service and
  emergency stop are healthy.

## 5. Capability map

### 5.1 Accounts and identity

| Capability | MVP | P1 | P2 |
|---|---:|---:|---:|
| Email or social login | yes |  |  |
| EVM wallet signature binding | yes |  |  |
| Multiple wallets |  | yes |  |
| Passkey |  | yes |  |
| Teams and organizations |  |  | yes |
| Regional availability and access control | yes |  |  |

Product requirement: wallet binding exists only to prove control or authorize
trading. A seed phrase or a main wallet's private key is never requested.

### 5.2 Natural-language strategy creation

| Capability | MVP | P1 | P2 |
|---|---:|---:|---:|
| Describe a strategy in English | yes |  |  |
| The model extracts instrument, timeframe, conditions, and risk | yes |  |  |
| It asks about ambiguous conditions | yes |  |  |
| It generates a constrained strategy program | yes |  |  |
| Rule visualization and a natural-language explanation | yes |  |  |
| Automatic DSL repair from errors | yes |  |  |
| Strategy templates | yes |  |  |
| Conversational revision | yes |  |  |
| Custom indicators from bounded formulas |  | yes |  |
| Sandboxed plugin strategies |  |  | yes |
| Multi-strategy portfolio generation |  |  | yes |
| News and social-sentiment driven strategies |  |  | yes |

Strategy elements supported first:

- Trend: SMA, EMA, price breakout.
- Momentum: RSI, MACD.
- Volatility: ATR, Bollinger Bands.
- Market behavior: volume, funding rate, open interest.
- Direction: long, short, both.
- Entry: condition combinations, crosses, consecutive satisfaction, cooldowns.
- Exit: inverse conditions, stop loss, take profit, trailing stop, maximum
  holding time.
- Sizing: fixed notional, a percentage of the account, or risk derived from stop
  distance.

Custom strategies do not depend on adding templates forever. The model generates
constrained TypeScript directly, and the platform keeps it controllable through
the Strategy SDK, AST safety checks, a QuickJS/WASM sandbox, version hashes, and
one runtime. The DSL is only an optional internal IR and no longer has to carry
every user expression. The full design is in
[strategy program design](STRATEGY_PROGRAM.md).

### 5.3 Strategy editor

- Chat, program, explanation views, and a key-rule summary stay in sync.
- Shows the data fields a strategy depends on and the time range available.
- Shows the original wording that is unquantifiable or ambiguous.
- Every revision produces an immutable version.
- Version comparison, rollback, and fork.
- Stores the model, prompt version, and compiler version used at creation.

### 5.4 Market data workbench

| Capability | MVP | P1 | P2 |
|---|---:|---:|---:|
| Candles and volume | yes |  |  |
| Funding and open interest | yes |  |  |
| Strategy signal overlay | yes |  |  |
| Order and fill overlay | yes |  |  |
| Data gap and quality notices | yes |  |  |
| Cross-venue price comparison |  | yes |  |
| L2 order-book replay |  | yes |  |
| Liquidation heatmap |  | yes |  |
| On-chain metrics |  |  | yes |

### 5.5 Backtesting

The MVP must have:

- Explicit data start and end times, with a time zone.
- Bar-close and next-bar execution semantics that prevent lookahead leakage.
- Maker/taker fees.
- Funding paid and received.
- A configurable slippage model.
- A simplified leverage and isolated/cross margin model.
- Take profit, stop loss, and liquidation simulation.
- Separate long and short statistics.
- Complete orders, fills, and the equity curve.
- An in-sample / out-of-sample split.
- Reproducible results for identical parameters.

P1 adds:

- Walk-forward validation.
- Parameter sensitivity heatmaps.
- Monte Carlo resampling of trade order.
- Bull, bear, ranging, and high-volatility segments.
- Slippage estimation driven by a real order book.
- Paper-versus-backtest divergence analysis.

Core metrics:

- Net return, CAGR.
- Maximum drawdown, drawdown duration.
- Sharpe, Sortino, Calmar.
- Profit factor, expectancy, win rate.
- Exposure, turnover, trade count.
- Fees, funding, and slippage as separate line items.
- Long/short performance and performance across market phases.

### 5.6 AI result interpretation

- Summarize in plain language how the strategy makes and loses money.
- Point out risks such as too few samples, overfitting, or one trade contributing
  too much.
- Find the worst market phase and the longest losing streak.
- Compare what actually changed between two strategy versions.
- Suggest experiments, but never deploy a suggestion straight to live.
- Every conclusion links to the underlying data and trade records.

### 5.7 Live paper trading

- Uses the same live market data and strategy runtime as live trading.
- A separate virtual account, balance, position, and PnL.
- Simulated fees, funding, and slippage.
- Backfills missed events after a reconnect.
- Strategy state, last heartbeat, and next evaluation time are visible.
- Pause, resume, and stop are supported.
- Paper records cannot be selectively deleted by the user; they can be archived,
  and the history is kept.

### 5.8 Controlled live trading

Live is P1 and is not a prerequisite for the first public MVP.

- Hyperliquid API wallet / agent wallet authorization.
- The user sets maximum notional, leverage, and which instruments may trade.
- Every order passes through an independent risk engine before submission.
- Three record layers: order intent, exchange order, and fill.
- Client order IDs guarantee idempotency.
- Automatic reconnection, state reconciliation, and pause on anomaly.
- A dead man's switch and one-click authorization revocation.
- No transfer or withdrawal permissions.

### 5.9 Risk center

MVP:

- Maximum risk per trade.
- Maximum position and maximum leverage.
- A daily loss limit.
- A maximum strategy drawdown.
- A maximum number of simultaneous positions.
- Reduce-only mode.
- No new positions when data is abnormal or the feed is down.

P1:

- Portfolio-level exposure limits.
- Correlation constraints.
- Volatility-driven dynamic deleveraging.
- Capital allocation across strategies.
- Exchange status and abnormal spread protection.

### 5.10 Monitoring and notifications

- Strategy started, paused, failed.
- A signal was produced but rejected by risk control.
- Order placed, partially filled, filled, cancelled.
- Stop loss, drawdown, and daily loss triggers.
- Data feed latency or gaps.
- Wallet authorization about to expire.
- MVP supports in-app and email; P1 adds Telegram, Discord, and webhooks.

### 5.11 Strategy assets and community

MVP:

- A private strategy library.
- Strategy versions and tags.
- A shareable read-only backtest page.
- The share page clearly distinguishes backtest, paper, and live.

P1:

- Public strategy pages.
- Forks and derivation relationships.
- Verifiable paper/live records.
- Creator pages, following, and update notifications.
- Sorting separately by return, drawdown, stability, and runtime duration.

P2:

- Paid strategy subscriptions.
- A strategy marketplace.
- Revenue or trading-fee sharing.
- Community challenges.

A leaderboard must never sort on absolute return alone, which would reward
extreme leverage and survivorship bias.

### 5.12 Billing

A pricing scheme to test:

| Plan | Suggested price | Capability |
|---|---:|---|
| Free | $0 | Limited backtests, templates, public sharing |
| Pro | $29/month | More backtests, full metrics, live paper trading |
| Advanced | $99/month | Multiple running strategies, advanced validation, notifications |
| Creator | $199/month or revenue share | A public page, subscriptions, audience analytics |

In P1, live trading may add a builder fee that the user explicitly authorizes.
Any fee must be shown transparently at authorization and on every fill record.

### 5.13 Operations and admin

- User, region, plan, and quota management.
- Model call, data call, and backtest cost accounting.
- Reporting of strategies and shared content.
- Risk event and trading anomaly lookup.
- A data quality dashboard.
- A global pause for a venue, an instrument, or live service.
- User data export and deletion flows.
- Audit log search; silently modifying trade records from the admin panel is
  forbidden.

## 6. MVP scope

### 6.1 The MVP must ship

1. Email login and wallet binding.
2. English natural language producing a constrained strategy program.
3. Rule-tree editing and version management.
4. 15m, 1h, and 4h data for BTC, ETH, and SOL.
5. OHLCV, funding, and open interest.
6. Deterministic backtesting including fees, funding, and slippage.
7. In-sample / out-of-sample reports.
8. Live paper trading.
9. Baseline risk limits.
10. In-app and email notifications.
11. Shareable backtest and paper pages.
12. An admin panel and a global kill switch.

### 6.2 The MVP explicitly does not

- Hold user funds.
- Copy trading or managing money for others.
- Deploy automatically optimized parameters straight to live.
- A native mobile app.
- Live trading on multiple exchanges.
- High frequency, arbitrage, market making.
- Options, spot portfolios, and cross-chain DeFi.
- News or social content triggering orders directly.
- A paid strategy marketplace.

## 7. Product gates and safe defaults

- A new strategy defaults to private, to paper, and to no leverage amplification.
- Every switch from paper to live requires explicit confirmation of the strategy
  version and the risk limits.
- Editing a live strategy creates a new version; running logic is never
  hot-swapped.
- An AI-generated new version must be re-backtested and never inherits live
  eligibility automatically.
- When data is missing, prices are abnormal, or state cannot be reconciled, only
  position reduction is allowed.
- When the system cannot confirm a position, it must stop opening new ones and
  notify the user.
- Any display of returns simultaneously shows the time range, maximum drawdown,
  trade count, and run type.

## 8. Core metrics

### 8.1 The north-star metric

The number of active strategies producing valid decision evidence each week.

"Valid decision evidence" means at least one of a completed backtest, live paper
trading, or controlled live trading, with complete data and run records.

### 8.2 Activation metrics

- Conversion from signup to a first valid strategy.
- Median time from first input to a valid backtest.
- First-backtest completion rate.
- Share of users who deploy to paper in their first week.

### 8.3 Retention and business metrics

- Share of users still running a strategy in weeks 2 and 4.
- Strategy versions per active user.
- Strategies running continuously on paper for 7 and 30 days.
- Free-to-Pro conversion.
- Gross margin and data cost per paying user.

### 8.4 Trust and safety metrics

- Signal agreement between backtest and paper.
- Fill divergence between paper and live.
- Data gap rate and recovery time.
- Share of order intents rejected by risk control.
- Orders the user did not expect — target zero.
- Trading incidents, fund-security incidents, and materially wrong displays —
  target zero.

Trade count and total leverage must never be core growth metrics.

## 9. Launch phases

### Phase 0: research prototype

- The Strategy SDK, program compiler, and sandbox.
- Historical data collection.
- Single-strategy backtesting.
- Internal golden cases and consistency tests.

Exit condition: 20 preset strategies compile reliably and reproduce their
results.

### Phase 1: closed MVP

- The web product.
- Conversational generation, editing, backtesting, paper trading.
- 30–50 design partners.
- Share pages and basic billing.
- Sell research, backtest, and paper subscriptions only; no trading fees.

Exit condition: users go from strategy creation to paper trading without human
help, with no serious consistency problems in data, backtesting, or execution.

### Phase 2: controlled live trading

- Hyperliquid API wallets.
- An independent risk and execution service.
- A small, instrument-limited, leverage-limited invite test.
- Builder fees.
- Open only in countries a legal advisor has approved, never "launch globally and
  exclude later".

Exit condition: continuous operation, reconnect recovery, position
reconciliation, the kill switch, and a security audit all pass.

### Phase 3: the strategy network

- Public verification records.
- Forks, following, creator pages.
- Strategy subscriptions and revenue sharing.

## 10. Product hypotheses to validate

1. Users are willing to describe trading rules precisely enough in natural
   language.
2. "Trustworthy backtesting" builds long-term willingness to pay better than "AI
   prediction".
3. Target users are willing to run paper first rather than go live immediately.
4. A verifiable strategy page spreads organically on X, Discord, and Telegram.
5. Users will pay for continuous operation, notifications, and advanced
   validation.
6. A builder fee does not materially reduce live conversion.
7. Hyperliquid provides stable enough data and execution to be the launch venue.

## 11. Questions for user interviews

- How do you turn a trading idea into rules today?
- Which part of existing backtest tools do you trust least?
- How long would you run a strategy on paper before going live?
- Would you rather pay a subscription, an execution fee, or a profit share?
- Which metrics would you publish, and which must stay private?
- What evidence would convince you a strategy record has not been tampered with
  or cherry-picked?
- Which exchange, wallet, and notification tools do you use today?

## 12. Business dependencies

Product scope, regional availability, billing, and creator features must be
reviewed together with the
[business and market plan](BUSINESS_PLAN.md). The following may never ship on a
product or engineering decision alone:

- Automated live execution.
- Builder fees, referral rebates, and profit sharing.
- Paid strategy subscriptions, copy trading, or leaderboard incentives.
- Advertising to a specific country or recruiting creators to promote.
- Marketing language such as "returns", "alpha", or "automatic money".
- Adding centralized exchange API keys or any custodial capability.
