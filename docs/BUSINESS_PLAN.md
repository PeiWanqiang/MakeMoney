# Business and market plan: Crypto Strategy Studio

English | [简体中文](BUSINESS_PLAN.zh-CN.md)

Status: Draft v0.1  
Related: [product specification](PRODUCT_SPEC.md) | [technical architecture](TECH_ARCHITECTURE.md)

User feedback, pricing, and acquisition experiments follow the
[generalization-first acceptance policy](GENERALIZATION_POLICY.md) too: an
individual case forms a hypothesis and is never extrapolated directly into a
market conclusion. Only evidence across users and across situations becomes
standard product or business strategy.

> This is a product and operating plan. It is not legal, tax, or financial
> licensing advice for any country. Before live trading, personalized strategies,
> execution fees, or creator revenue sharing ship, a qualified lawyer in the
> target market must provide a written analysis.

## 1. Business conclusion

The project should ship in two commercial stages, rather than launching all at
once as a "global AI automated trading platform".

### Stage A: a research and validation SaaS

What is sold:

- Natural-language strategy compilation.
- Historical backtesting.
- Out-of-sample validation.
- Live paper trading.
- Strategy versions, reports, and sharing.

Primary revenue: software subscriptions.

Goal: find out whether users will keep creating, keep running, and pay for
trustworthy validation — without depending on live-trading revenue while the
regional and licensing boundaries are still unclear.

### Stage B: a controlled execution platform

What is added:

- Non-custodial trade execution that the user authorizes.
- Live risk control and monitoring.
- Builder fees.
- A verifiable live record.

Primary revenue: premium subscriptions plus transparent execution fees.

Entry condition: legal opinions for target countries, venue terms, payment rails,
user terms, a security audit, and incident response are all in place.

### Stage C: the strategy network

What is added:

- Creator pages and subscriptions.
- Strategy forks and a derivation network.
- A strategy marketplace and revenue sharing.

Primary revenue: subscription take rate, creator tooling fees, and trading
revenue.

Entry condition: promotion, personalized recommendations, copy trading, conflicts
of interest, and creator disclosure obligations are resolved first. Community
features here are not ordinary UGC.

## 2. The first segment

### 2.1 Beachhead

The first users are defined as:

> English-speaking users who already trade crypto perpetuals, can describe their
> rules, but cannot build a full quant system.

That is narrower than "everyone who wants to make money with AI", but willingness
to pay, intensity of need, and feedback quality are all higher.

### 2.2 Priority user profile

- At least several perpetual trades a month.
- Understands funding, leverage, liquidation, and stop losses.
- Already uses TradingView, exchange charts, or simple bots.
- Active on X, Discord, or Telegram.
- Currently expresses strategies by watching charts, setting alerts, or writing
  Pine Script.
- Willing to run paper for 7–30 days first.

### 2.3 Users not actively acquired

- Complete beginners and minors.
- Anyone looking for guaranteed returns, managed accounts, or high-leverage
  signal calls.
- Users in prohibited or unassessed regions.
- Users evading regional restrictions with a proxy.
- Users who want the platform to hold funds, transfer on their behalf, or pool
  capital.

## 3. Customer value and positioning

### 3.1 Core positioning

Proposed brand claim:

> Build the strategy. Verify the edge. Stay in control.

Alternative:

> Don't trust the AI. Verify the strategy.

### 3.2 Marketing language we do not use

- AI makes money for you.
- Guaranteed alpha/returns.
- Risk-free passive income.
- Beat the market automatically.
- Copy this strategy and earn X%.
- Beginner-friendly leverage, or anything encouraging beginners to go live
  directly.

### 3.3 Where we compete

Not on chat quality against a general-purpose model, but on:

1. Backtest credibility and cost modeling.
2. Consistency across backtest, paper, and live.
3. Strategy versions and a run record that cannot be cherry-picked.
4. The risk engine and non-custodial execution.
5. High-quality historical data and real fill divergence.
6. A shareable, forkable network of strategy assets.

## 4. Packaging and pricing

### 4.1 Stage A pricing experiment

| Plan | Suggested monthly price | Limits and value |
|---|---:|---|
| Free | $0 | 3 private strategies, limited backtests, 1 paper deployment, branded public sharing |
| Pro | $29 | More backtests, 5 paper deployments, full validation, email notifications |
| Advanced | $99 | 20 paper deployments, advanced validation, webhook/Telegram, priority queue |
| Creator Beta | $149–199 | A public page, more sharing analytics, audience and version tools |

These prices are hypotheses to test, not commitments. An annual plan can offer
roughly two months off, but early on a deep discount must not paper over a
retention problem.

### 4.2 Stage B execution fees

The Hyperliquid builder code lets a user pre-authorize an app to charge a fee on
fills it routes, and lets the user revoke it. Start testing at a low, transparent
rate rather than pricing at the maximum allowed.

Example:

- The user trades $1,000,000 notional a month.
- The builder fee is 0.5 bps, i.e. 0.005%.
- Monthly trading revenue is about $50.

The arithmetic: `1,000,000 × 0.00005 = 50`.

Trading revenue scales, but it also creates an incentive to encourage churn.
Therefore:

- Subscriptions must remain the main value exchange.
- Product metrics never optimize trade count or leverage.
- Every fee and the monthly total are visible to the user.
- Leaderboards never reward volume or total fees paid.
- Risk controls are never loosened because of a user's plan or revenue
  contribution.

### 4.3 Stage C creator revenue

Worth testing:

- A monthly creator tooling fee.
- A 15%–30% platform take on paid strategy subscriptions.
- A clearly disclosed share of builder fees.

Until the legal analysis is complete, no revenue share based on a user's profit,
and no one-click copy trading. Profit sharing can materially change the advisory,
asset-management, and conflict-of-interest analysis.

## 5. Go to market

### 5.1 The first acquisition loop

```text
public strategy experiments and post-mortems
  -> a verifiable share page
  -> the user forks the strategy
  -> a free backtest
  -> deploy to paper
  -> the 7-day result email
  -> Pro conversion
```

The share page must be the product's own distribution unit, not a report visible
only after login.

### 5.2 Channel priority

1. X: public strategy experiments, development logs, and validation results.
2. Discord/Telegram: small trading communities and design partners.
3. YouTube: full strategy validations with trading-education creators, not signal
   placements.
4. Reddit: methods, failure cases, and tool explanations, without spam.
5. SEO: high-intent content around funding strategy backtest, crypto strategy
   builder, and similar.
6. The TradingView community: strategy import, migration, and result comparison.

Large paid advertising is not the focus in the first stage. Finance and crypto ad
review is strict, and before the product has proven retention it mostly buys
low-quality, get-rich-quick users.

### 5.3 The design partner program

Goal: recruit 30–50 users, not maximize signups.

Terms:

- Free use for 2–3 months.
- One structured feedback session a week.
- Permission for the platform to analyze usage paths anonymously.
- No requirement to publish returns or provide an endorsement.
- Separate, explicit permission from anyone willing to be a public case study.

Composition:

- 20 discretionary traders.
- 10 traders who know Pine Script.
- 5–10 small creators.
- 5 users with a quant background, tasked with challenging backtest correctness.

### 5.4 Content strategy

Suggested content:

- Why a strategy that looks highly profitable is overfitted.
- How results change once funding, fees, and slippage are included.
- Why backtest and live paper trading diverge.
- A complete post-mortem of a failed strategy.
- The path from one sentence of natural language to deterministic rules.

Content builds a "credible validation" brand, not a gallery of extreme return
screenshots.

## 6. Funnel and lifecycle

### 6.1 The funnel

| Stage | Core action | Metric |
|---|---|---|
| Acquisition | Views a public strategy or content | Qualified visits |
| Activation | Completes a first valid backtest | Time to first backtest |
| Proof | Deploys and runs paper | 7-day active strategies |
| Conversion | Upgrades to Pro | Free-to-paid |
| Retention | Keeps running and iterating | 4/8-week retained payers |
| Expansion | More deployments and advanced validation | Net revenue retention |
| Referral | Shares or forks | Organic invites / forks |

### 6.2 Operating targets

These are early operating bars, not industry facts:

- First valid backtest completion: above 50%.
- Median time to first backtest: under 5 minutes.
- Activated users deploying paper: above 30%.
- Free to paid: 3%–8%.
- Monthly paid churn: below 6%, targeting below 4% at maturity.
- Organic and referral share of new users: above 40%.
- Subscription gross margin: above 75%.
- CAC payback: under 4 months.

If users backtest once and leave, the business is not proven, however good the
signup and sharing numbers look.

## 7. Unit economics

### 7.1 Cost per user

- LLM compilation and explanation.
- Backtest CPU and memory.
- Market data collection, storage, and queries.
- Live paper execution.
- Email, Telegram, and webhooks.
- Payment processing, refunds, and chargebacks.
- Support and risk incident handling.

Target cost structure:

| Cost | Target share of subscription revenue |
|---|---:|
| LLM | under 5% |
| Backtest and live compute | under 8% |
| Data and storage | under 7% |
| Payments, tax, and refund loss | 4%–10% |
| Direct support cost | under 5% |

Higher plans should control cost through concurrent runs, backtest priority, data
granularity, and history range, not through request counts alone.

### 7.2 Key financial scenarios

Build three models:

- Subscription only.
- Subscription plus builder fees.
- The creator network.

Bull-market volume must never be the base case; the stress scenario should assume
volume falls 70%, paid conversion drops, and support costs rise.

### 7.3 Cash discipline

- Do not expand onto expensive real-time data sources before retention is proven.
- Never trade company assets to subsidize revenue.
- Keep strict accounting separation between user funds, company funds, and
  builder-fee revenue.
- Accepting stablecoin subscriptions requires its own accounting, tax, sanctions,
  and refund processes.

## 8. Regional and regulatory strategy

### 8.1 Core principles

- "Non-custodial", "just software", and "decentralized" do not automatically
  exclude financial regulation.
- Perpetuals are treated as derivatives, or potentially under CFD rules, in
  several major markets.
- Personalized strategies, automated execution, introducing clients, execution
  fees, and creator revenue sharing all change the regulatory analysis.
- The website, share pages, social posts, and creator content may all constitute
  marketing or a financial promotion.
- IP blocking is one control among several; it does not replace user
  attestations, sanctions screening, terms, and ongoing monitoring.

### 8.2 How launch regions are chosen

This document deliberately does not assert a list of "legal countries". The
correct process is:

1. Pick 5–8 candidate countries from existing user and channel data.
2. Analyze research/paper and live as two separate products for each country.
3. Have local counsel assess advice, arranging/dealing, derivatives, promotion,
   AML, consumer law, privacy, and tax.
4. Produce a versioned country matrix and admission rules.
5. Open live trading by allowlist, not by maintaining a denylist.

### 8.3 Markets to exclude or approve separately first

Until legal opinions and the corresponding permissions exist, live functionality
should stay off at least in:

- The United States: digital asset derivatives and the CTA/IB boundary need a
  dedicated CFTC/NFA analysis.
- The United Kingdom: crypto financial promotion rules aimed at UK consumers have
  extraterritorial effect and can capture a website and social promotion.
- The EU/EEA: ESMA has cautioned that a product named "perpetual futures" may
  still fall within the MiFID II / CFD product intervention scope.
- Australia: perpetual futures can be derivatives, and providing advice,
  arranging, or dealing services may require an AFS licence.
- Every sanctioned region, venue-restricted region, or region company policy
  prohibits.

Whether paper/research may open in those markets also needs its own analysis,
especially when a strategy is tailored to personal circumstances or marketing
induces trading.

### 8.4 Factual basis

- The CFTC brings several kinds of entity that advise on or service futures for
  others into its intermediary and registration framework. Standardized,
  non-customized software has had specific exemption paths, but personalization
  and automated execution require a fresh analysis.
- The UK FCA states explicitly that cryptoasset promotion rules apply to overseas
  firms marketing to UK consumers, and cover websites, apps, and social media.
- ESMA reiterated in 2026 that the commercial name "perpetual futures" does not
  determine classification, and that some such products are likely bound by
  existing CFD measures.
- ASIC treats certain crypto-related products including perpetual futures as
  possible derivatives, and notes that advising, arranging, or dealing services
  may require the corresponding licence.

References:

- [CFTC intermediary registration](https://www.cftc.gov/IndustryOversight/Intermediaries/registration.html)
- [CFTC Commodity Trading Advisors](https://www.cftc.gov/IndustryOversight/Intermediaries/CTAs/index.htm)
- [FCA marketing cryptoassets to UK consumers](https://www.fca.org.uk/firms/cryptoassets/marketing-uk-consumers)
- [ESMA statement on perpetual futures and CFD measures](https://www.esma.europa.eu/press-news/esma-news/esma-reminds-firms-their-obligations-under-cfd-product-intervention-measures)
- [ASIC digital assets: financial products and services](https://www.asic.gov.au/regulatory-resources/digital-transformation/digital-assets-financial-products-and-services/)

### 8.5 Incorporation

Where the company sits must not be chosen on tax rate alone. Candidate
jurisdictions need comparison on:

- Where the founders are and where management actually happens.
- Availability of banking and payment accounts.
- Regulation of software, digital assets, and derivatives.
- Investor acceptance.
- Employment and option arrangements.
- Data protection and cross-border transfer.
- Corporate income tax, GST/VAT, withholding, and accounting for token revenue.
- A path to future licensing or partnership with a licensed institution.

If the core team operates from Singapore, Singapore corporate, financial
regulatory, and tax counsel should first assess the boundaries of a Pte. Ltd. as
a software entity before deciding whether another entity is needed. Do not use a
shell offshore company to obscure where the business actually operates.

## 9. Payments, tax, and billing

### 9.1 Payment providers

Stripe cannot be assumed. Stripe lists parts of cryptocurrency, investment,
brokerage, and other financial services as restricted businesses that need extra
review or may not be supported, and the rules differ by country of registration.
[Stripe restricted businesses](https://stripe.com/legal/restricted-businesses)

Before charging, prepare at least:

- A complete product description and data flow.
- Whether live trading is offered, whether fees are charged, and the money flow.
- Company and beneficial owner information.
- Countries served and geo-controls.
- Terms, privacy policy, risk disclosure, and refund policy.
- The basis of any partnership or interface with an exchange or protocol.

Evaluate in parallel:

- Stripe pre-screening.
- Written pre-screening with a merchant of record such as Paddle or Lemon
  Squeezy.
- Crypto payment providers — but never as a way to bypass financial business
  review.

### 9.2 Tax

- VAT/GST/sales tax on subscription revenue.
- The difference in responsibility between a merchant of record and direct
  collection.
- Revenue recognition and on-chain evidence for builder fees.
- Tax forms, withholding, and identity information for creator revenue shares.
- Valuation, conversion, and accounting policy for stablecoin revenue.

## 10. Legal and contract checklist

### 10.1 Before launching research/paper

- Terms of Service.
- Privacy Policy and cookie notice.
- Risk disclosure.
- Acceptable use policy.
- Subscription, cancellation, and refund terms.
- Disclosure of data sources and third-party services.
- A marketing copy review standard.
- Sanctions and regional restriction processes.

### 10.2 Before launching live

- Legal opinions for each target region.
- A live trading addendum.
- API wallet authorization and revocation documentation.
- Disclosure of execution, latency, slippage, downtime, and irreversible trade
  risk.
- Builder fee disclosure and user acknowledgment.
- A conflicts of interest policy.
- Complaint, incident, and dispute handling.
- A third-party security audit report.
- A review of the Hyperliquid interface and brand usage terms.

### 10.3 Before launching the creator network

- A creator agreement.
- Disclosure of paid promotion and financial relationships.
- Content moderation and record keeping.
- A prohibition on return promises, fabricated performance, and deleting failed
  records.
- Copyright, strategy IP, and fork licensing.
- Revenue share, refund, tax, and termination rules.

## 11. Partners

### 11.1 Required

- Financial regulatory counsel in target markets.
- Corporate and cross-border tax advisors.
- A payment provider or merchant of record.
- Cloud and security vendors.
- External penetration testing and wallet security audit teams.
- Venue and protocol ecosystem contacts.

### 11.2 Growth

- Small, high-trust trading creators.
- TradingView and Pine Script educators.
- Crypto research communities.
- Wallets, trading terminals, and data tools.

Every affiliate and creator must disclose the financial relationship, and
unverified return screenshots are never allowed as advertising.

### 11.3 Platform dependency risk

Hyperliquid is the launch venue and must not become a permanent single point:

- API or terms changes.
- Changes to regional restrictions.
- Changes to builder fee rules.
- Protocol, oracle, network, and liquidity risk.
- Brand or regulatory events.

Mitigation: a venue-neutral DSL, a unified market data model, and a broker
adapter internally; after P1, prepare a paper integration with a second venue,
without rushing it to live.

## 12. Support, trust, and incidents

### 12.1 Support tiers

- P0: suspected unauthorized trading, key exposure, wrong orders, or a global
  data anomaly.
- P1: positions that cannot be reconciled, a strategy that did not pause per its
  rules, a materially wrong backtest.
- P2: a single user's run failure, billing, and authorization problems.
- P3: usage, explanation, and general feedback.

24/7 P0 on-call capability is required before live launches; without on-call, do
not promise round-the-clock automated trading.

### 12.2 Incident response

- Stop any trading that increases risk immediately.
- Preserve market data, strategy state, intents, risk decisions, and exchange
  responses.
- Never close a user's position unilaterally, unless a risk policy they
  pre-authorized explicitly allows it.
- Publish the blast radius and recovery progress on a public status page.
- Give the user a readable incident timeline.
- Complete a post-mortem and prevention measures.

### 12.3 Liability and insurance

Do not assume a disclaimer in the terms covers an erroneous trade. Before live
launch, evaluate:

- Technology E&O.
- Cyber insurance.
- Directors and officers liability.
- A compensation policy and liability cap.

## 13. Brand and intellectual property

- "VibeTrade / Vibe Trading" already collides with several identical or similar
  products and is not a final brand that can skip review.
- Run trademark and domain searches in the major countries before settling on a
  brand.
- The strategy DSL, backtest engine, data quality, and verification records are
  the core IP.
- Users keep the rights to their original strategy content; the platform needs a
  licence to run it, display it, and generate derived metrics.
- Forks need a clear public licence and an attribution chain.
- Do not copy third-party paid indicators, Pine Script, or datasets.

## 14. Team and operating capability

Even with AI doing much of the development, these responsibilities must have a
named owner:

- Product and business.
- Trading correctness / quant.
- Wallet and execution security.
- Data quality.
- Legal and compliance liaison.
- P0 incidents.
- User support.

AI increases delivery speed. It cannot sign off, own asset security, take a
production on-call shift, or carry legal responsibility.

## 15. Business stage gates

### Gate A: start charging for subscriptions

- 20+ users have completed a first valid backtest.
- At least 10 have run paper continuously for 7 days.
- A payment provider has approved the business model in writing.
- Terms, privacy, risk, and refund documents are ready.
- Direct cost per user is measurable.

### Gate B: scale paid acquisition

- At least 50 paying users.
- Two-month paid retention within the target range.
- A repeatable organic or content channel.
- Gross margin above 75%.
- Conversion does not depend on promising returns.

### Gate C: invite-only live trading

- Legal opinions and the allowlist for target countries are complete.
- Hyperliquid terms and technical authorization have been reviewed.
- Wallet, execution, reconciliation, and kill switch security audits pass.
- P0 on-call and incident drills pass.
- User fee and conflict disclosures are complete.

### Gate D: open creator monetization

- The creator agreement and content moderation are live.
- Verifiable records cannot be selectively deleted.
- Promotion, performance display, and relationship disclosure rules are
  enforceable.
- Revenue share, tax, and refund systems are complete.

## 16. The 90-day business validation plan

### Days 1–30: the problem and willingness to pay

- Interview 30 target traders.
- Collect at least 100 real natural-language strategy phrasings.
- Test three positioning pages and two price points.
- Recruit the first design partners.
- Shortlist 5–8 candidate countries for legal analysis.
- Pre-screen with at least three payment or merchant-of-record providers.

### Days 31–60: closing the loop

- Get users through the whole path from idea to backtest to paper.
- Publish 5 complete failure and success post-mortems.
- Measure activation, paper deployment, and repeat use.
- Verify whether public share pages produce forks and signups.
- Complete the terms needed for research/paper.

### Days 61–90: validating revenue

- Charge a real subscription to a subset of active users.
- Test Pro at $29 and $49, not just stated intent.
- Assess refunds, support, and compute costs.
- Confirm whether Gate A is met.
- Only after Gate A, invest in full live infrastructure and dedicated legal
  spend.

## 17. Signals to stop or reposition

Any one of these means pausing expansion and rethinking positioning:

- Users only want signals and will not create or validate strategies.
- Continuous paper running is low and the tool becomes a one-off backtest toy.
- Paying depends mainly on exaggerated return claims.
- Payment providers broadly reject the business model.
- The reachable country markets are too small or acquisition cost is
  unacceptable.
- Backtest-versus-paper divergence persists and never earns trust.
- Security and on-call costs make live trading unable to produce a reasonable
  gross margin.
- Builder fees create an obvious conflict between product incentives and user
  interests.
