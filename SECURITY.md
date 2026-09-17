# Security Policy

## Why this project takes security seriously

This repository generates TypeScript from natural language with a language
model and then executes it. A generated strategy program can, once a user
explicitly authorizes live trading, place real orders on a real exchange.
The validator, the sandbox and the authorization gate are therefore not
hardening details; they are the product's core safety boundary.

The project never takes custody of user funds, and never accepts seed phrases
or main-wallet private keys.

## Supported versions

The project is a pre-1.0 prototype. Only `main` receives fixes.

## Reporting a vulnerability

Please report privately through GitHub's **Report a vulnerability** button on
the [Security Advisories page](https://github.com/PeiWanqiang/MakeMoney/security/advisories/new),
not through a public issue.

This repository is maintained by one person, so please allow up to 7 days for
an initial reply.

## In scope

Findings in these areas are the ones that matter most:

- **Sandbox escape** — any way for a strategy program to reach the host from
  inside the QuickJS runtime, or to exceed its time or memory limits.
- **Validator bypass** — source that passes `validate-strategy-source.ts`
  while still using a forbidden construct, identifier or global.
- **Secret exposure** — any path that writes an API key into a session
  artifact, a report, a log line or a diff. Keys are read from the
  environment only.
- **Authorization bypass** — anything that reaches live-order placement
  without the explicit user authorization and risk review that path requires.
- **Backtest service** — unauthenticated or unsafe behavior in the Fastify
  service under `services/backtest/`.

## Out of scope

- Losses from a strategy that behaves as written but performs badly. This
  software is for research, is not investment advice, and trading crypto can
  lose the entire principal.
- Vulnerabilities in a third-party exchange, data source or model provider.
  Please report those to the vendor directly.
