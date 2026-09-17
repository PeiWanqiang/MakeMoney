# Web product design: login, a stepped flow, My Strategies, and bilingual UI

English | [简体中文](WEB_PRODUCT_DESIGN.zh-CN.md)

Status: Design v1 — implemented as written here (2026-08-01). Deviations from the
design are in §8.
Related: [product specification](PRODUCT_SPEC.md) | [project status](PROJECT_STATUS.md) | [generalization-first acceptance policy](GENERALIZATION_POLICY.md)

This covers the login and object-ownership part of the one open item in
[project status 2.8](PROJECT_STATUS.md) — **"login, object ownership, sharing,
subscriptions, billing, and asynchronous backtest jobs are not done"** — plus an
information-architecture rework and internationalization.

Four decisions are settled: sign in with a Google account; anonymous use through
step 2, with login required before backtesting; `/zh` and `/en` URL prefixes; and
stepped routes that render only the current step.

---

## 1. Problems today

What the code actually is (`web/app/page.tsx`, 597 lines, plus
`web/app/backtest-workspace.tsx`, over 1,000 lines):

1. **The entire product is one route, `/`.** Marketing content (hero, the
   four-step explanation, why it is trustworthy, the closing CTA) and the
   four-step workflow are strung together on one long page, navigated with
   `#workspace` and `#backtest` anchors.
2. **The first screen of step 1 is marketing, not an input box.** The user has to
   scroll past a full screen before starting, while the stepper at the top
   already marks "Describe your strategy" as in progress — the progress bar says
   you are working, and the page is still introducing itself.
3. **All state lives in React memory.** `result`, `confirmed`, and `milestone`
   are `useState`, so a refresh loses everything, no link can address an
   intermediate step, and nothing can be shared.
4. **There are no users.** Identity is a `crypto.randomUUID()` in localStorage,
   sent to the server as `sessionId` in the **request body**, and the server uses
   `WHERE id = ? AND session_id = ?` as authorization. Switching device,
   clearing cache, or changing browser loses everything.
5. **The language is hard-coded Chinese.** Only the clarification exchange
   guesses the language with `usesChinese(intent)` (`page.tsx:84`), which is a
   stopgap; the server's `detectOutputLanguage` also guesses. Every label in the
   `strategy-language.ts` renderer and every error message in `backtest-api.ts`
   is a Chinese string literal.

---

## 2. Target information architecture

### 2.1 Routes

```
/                                  → 302 to /zh or /en by Accept-Language

/[locale]                          landing page (anonymous): intro + login + start now
/[locale]/new                      Step 1 · Describe your strategy (anonymous, input only, no marketing)
/[locale]/s/[id]                   → 302 to whichever step this strategy is on
/[locale]/s/[id]/confirm           Step 2 · Confirm the interpretation (anonymous)
/[locale]/s/[id]/backtest          Step 3 · Historical validation (login required)
/[locale]/s/[id]/optimize          Step 4 · Auto optimization (login required)
/[locale]/strategies               My Strategies (login required)
/[locale]/account                  Account: language preference, sign out, delete data

/api/auth/google/start             begin Google OAuth
/api/auth/google/callback          OAuth callback
/api/auth/signout                  sign out
/api/auth/session                  current identity (for client components)
```

Reserved-path warning: the OpenAI Sites platform occupies
`/signin-with-chatgpt`, `/signout-with-chatgpt`, and `/callback` (see
`web/README.md`). **The Google callback cannot live at `/callback`**; it must be
`/api/auth/google/callback`.

### 2.2 Where the marketing content goes

The four arguments in today's full-screen `proof-section` split in two:

| Original content | Destination |
|---|---|
| Hero headline, subhead, four-step cards | The landing page `/[locale]`, appearing once |
| "It doesn't guess for you; it asks when something is missing" | A one-line subhead on step 1 |
| "Backtesting starts only after you confirm, and the rules are locked" | A one-line subhead on step 2, plus a note beside the confirm button |
| "Every trade is reviewable; the equity curve is not the only answer" | A one-line subhead on step 3 |
| "If nothing better is found, the original parameters stay; proving something is better is not luck" | A one-line subhead on step 4 |
| The "not investment advice" disclaimer | The global footer, plus under the step 1 input (keeping the existing `privacy-note`) |

The principle: **each step keeps one sentence explaining why that step exists**,
and the rest of the argument stays on the landing page. No full-screen marketing
block appears inside the workspace.

### 2.3 The stepper becomes navigation

The four-step progress bar at the top changes from a decorative status display
into **real route navigation**: completed steps are clickable (`<Link>`) and
unlocked steps are disabled, with the current step highlighted. That removes the
"step 1 is reading an introduction" mismatch — each step's URL, progress state,
and page content agree.

Completed steps collapse below into a one-line summary card (after step 2, for
example, "Confirmed: long when RSI is below 30, 5% stop · expand"), which expands
on click and takes no scroll height otherwise.

### 2.4 Persisting state

Stepped routes require state on the server. The strategy record already exists in
D1 (`strategy_submissions`); add:

- Step 1→2: `analyze` returns `id`, and the client does
  `router.push(/[locale]/s/${id}/confirm)`.
- Step 2 confirm: a new `POST /api/strategy/:id/confirm` writes `confirmed_at`.
  Today "confirmed" is only an in-memory `confirmed` state that a refresh loses.
- Steps 3 and 4: the `backtest_runs` and `optimization_runs` tables already
  exist; restore by reading the latest row per `strategy_submission_id`.
- The landing logic for `/[locale]/s/[id]`: an optimization → optimize; a
  backtest → backtest; a `confirmed_at` → backtest; otherwise confirm.

---

## 3. Identity and login (Google OAuth 2.0 + OIDC)

### 3.1 Why hand-written instead of a library

The runtime is a Cloudflare Worker (`vinext` plus `@cloudflare/vite-plugin`),
with no Node runtime. Authorization Code with PKCE can be implemented completely
with WebCrypto and `fetch`, without pulling in something like NextAuth, whose
Worker adapters are extra attack surface.

### 3.2 Data model

```sql
CREATE TABLE users (
  id             TEXT PRIMARY KEY,        -- uuid
  google_sub     TEXT NOT NULL UNIQUE,    -- Google's stable subject; the email is not the primary key
  email          TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  display_name   TEXT,
  avatar_url     TEXT,
  locale         TEXT NOT NULL DEFAULT 'zh',
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX users_google_sub_idx ON users(google_sub);
CREATE INDEX users_email_idx ON users(email);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,            -- SHA-256 of the raw token in the cookie
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id, expires_at);
```

Identity is keyed on `google_sub` rather than email: Google lets people change
their email address, but `sub` never changes. The email is only for display and
contact.

The database stores the SHA-256 of the token and the cookie holds the raw value,
so a database leak does not mean session takeover.

### 3.3 Login flow

```
1. The user clicks "Sign in with Google"
   → GET /api/auth/google/start?return_to=/zh/s/abc/backtest

2. The server:
   - state = 32 random bytes as hex
   - code_verifier = 43–128 random characters; code_challenge = BASE64URL(SHA256(verifier))
   - Set-Cookie: pt_oauth = {state, verifier, returnTo}, HttpOnly/Secure/SameSite=Lax/Max-Age=600
   - 302 → https://accounts.google.com/o/oauth2/v2/auth
       ?client_id=…&redirect_uri=…&response_type=code
       &scope=openid%20email%20profile&state=…
       &code_challenge=…&code_challenge_method=S256&prompt=select_account

3. Google calls back at GET /api/auth/google/callback?code=…&state=…
   - Compare query.state with the state in the cookie; 400 on mismatch (CSRF protection)
   - POST https://oauth2.googleapis.com/token
       code / client_id / client_secret / redirect_uri / grant_type=authorization_code / code_verifier
   - Decode the id_token and check iss ∈ {accounts.google.com, https://accounts.google.com},
     aud === GOOGLE_CLIENT_ID, and exp > now
     (the token endpoint response comes over a direct TLS connection to Google, so
     signature verification may be skipped per OIDC Core 3.1.3.7)
   - Upsert users (by google_sub)
   - Create auth_sessions, Set-Cookie: pt_session=<token>, HttpOnly/Secure/SameSite=Lax/Max-Age=30d
   - Claim anonymous records (see 3.5)
   - Clear pt_oauth, 302 → returnTo (validated as a same-origin relative path)
```

`return_to` reuses the approach of `safeRelativeReturnPath` in
`chatgpt-auth.ts:57`: it must start with `/`, not with `//`, resolve to the same
origin, and not point at an auth path itself.

### 3.4 Environment variables

Add to `.dev.vars` (already in `.gitignore`):

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

Authorized redirect URIs to register in the Google Cloud Console:

- `http://localhost:5173/api/auth/google/callback` (local dev; use whatever port
  vinext dev actually runs on)
- `https://<production domain>/api/auth/google/callback`

The callback address is derived on the server from the request's
`x-forwarded-proto` and `host` rather than hard-coded, so local and production do
not diverge.

### 3.5 Claiming anonymous work at login

Today `sessionId` lives in localStorage, where the server cannot read it. It
becomes a **server-issued HttpOnly cookie `pt_anon`** (`Set-Cookie` on the first
request), and the client no longer generates it.

On successful login, claim:

```sql
UPDATE strategy_submissions SET user_id = ?1
  WHERE session_id = ?2 AND user_id IS NULL;
```

Same for `backtest_runs` and `optimization_runs`. The effect: write a strategy
anonymously, read the interpretation, click login to backtest, and that strategy
appears in My Strategies without being rewritten.

### 3.6 Tightening the authorization model

**The weakness today**: the client puts `sessionId` in the **request body** and
the server treats it as an authorization credential (`backtest-api.ts:1296`,
`1678`, `1842`, and others). Anyone who knows a `strategyId` plus its `sessionId`
can read and keep operating on that strategy.

After the change:

- The server derives identity from the cookie, and **any `sessionId` in the
  request body is ignored**.
- Ownership resolves to `user_id = ?` OR (`user_id IS NULL` AND
  `session_id = ?`, where `session_id` comes from the `pt_anon` cookie).
- Steps 3 and 4 require a `user_id` on the server; without login they return
  `401 / code: AUTH_REQUIRED`, and the frontend redirects to login with
  `return_to`.
- **The deterministic ID for `optimization_runs` (`backtest-api.ts:1722`)
  currently mixes `sessionId` into the hash.** It changes to read the
  `session_id` stored on the strategy row (a server-side fact) instead of the
  request body, so the ID does not drift across a claim and historical experiment
  receipts stay reproducible.

Rate limiting follows the same split: anonymous traffic is counted per `pt_anon`
(stricter, and only on the analyze endpoint), logged-in traffic per `user_id`.

---

## 4. My Strategies

`GET /api/strategy/list` (login required) is one aggregate query:

```sql
SELECT s.id, s.title, s.asset, s.market, s.status, s.created_at, s.confirmed_at,
       b.net_return, b.max_drawdown, b.trade_count, b.created_at AS last_backtest_at,
       o.id AS optimization_id
FROM strategy_submissions s
LEFT JOIN (latest backtest_runs) b ON b.strategy_submission_id = s.id
LEFT JOIN (latest optimization_runs) o ON o.strategy_submission_id = s.id
WHERE s.user_id = ?
ORDER BY s.created_at DESC
LIMIT 50
```

Each row shows: title, instrument and timeframe, a progress badge (awaiting
confirmation / confirmed / backtested / optimized), the net return and maximum
drawdown of the latest backtest, and a timestamp. Actions: continue (jump to the
current step), rename, delete.

The empty state links straight to `/[locale]/new` rather than showing an empty
box.

Schema additions needed:

```sql
ALTER TABLE strategy_submissions ADD COLUMN user_id TEXT;
ALTER TABLE strategy_submissions ADD COLUMN title TEXT;         -- taken from strategyName at write time; user-editable
ALTER TABLE strategy_submissions ADD COLUMN confirmed_at TEXT;
ALTER TABLE strategy_submissions ADD COLUMN archived_at TEXT;
ALTER TABLE backtest_runs        ADD COLUMN user_id TEXT;
ALTER TABLE optimization_runs    ADD COLUMN user_id TEXT;
CREATE INDEX idx_strategy_submissions_user ON strategy_submissions(user_id, created_at DESC);
CREATE INDEX idx_backtest_runs_user        ON backtest_runs(user_id, created_at DESC);
CREATE INDEX idx_optimization_runs_user    ON optimization_runs(user_id, created_at DESC);
```

Note that SQLite's `ALTER TABLE ADD COLUMN` **does not support
`IF NOT EXISTS`**. Runtime table creation goes through `ensureSchema` in
`strategy-api.ts:65` and `backtest-api.ts:658`, which must first check
`PRAGMA table_info(<table>)` for the column before deciding whether to run the
statement. A matching migration also goes into `db/schema.ts` and `drizzle/` (the
next tag is `0006_*`).

---

## 5. Chinese and English

### 5.1 Getting the locale into `<html lang>`

`app/layout.tsx` is the root layout and cannot see the `[locale]` parameter.
**No middleware** (Next 16 marks `middleware.ts` deprecated); do it in
`worker/index.ts`, which already wraps `handler.fetch`:

```ts
// worker/index.ts
const locale = localeFromPathname(url.pathname);           // /zh/... → "zh"
if (!locale) return redirectToLocale(request, url);        // "/" → /zh or /en, by Accept-Language
const localized = new Request(request, {
  headers: new Headers([...request.headers, ["x-prooftrade-locale", locale]]),
});
return handler.fetch(localized, env, ctx);
```

`app/layout.tsx` reads `x-prooftrade-locale` via `headers()` to set
`<html lang>`, and page components take it from `params.locale`. Both paths agree
because both derive from the pathname.

### 5.2 Dictionaries

No i18n library; a hand-written, type-safe dictionary:

```
app/i18n/locales.ts        LOCALES = ["zh", "en"]; type Locale
app/i18n/zh.ts             export const zh = { ... } as const
app/i18n/en.ts             export const en: typeof zh = { ... }   ← a missing key is a compile error
app/i18n/index.ts          getMessages(locale)
```

Client components (`page.tsx` and `backtest-workspace.tsx` are both
`"use client"`) receive `messages` as a prop from a server component — a plain
serializable object, with no context provider needed.

### 5.3 Three server-side areas that must change together

Translating the UI alone is not enough; Chinese leaks out of three places:

1. **`app/strategy-language.ts`** — the contract renderer. `FIELD_LABEL`,
   `TIMEFRAME_LABEL`, `COMPARISON_LABEL`, `POSITION_LABEL`, and `describeRisk`
   are all Chinese literals, and `humanizeExpression` **concatenates** its
   Chinese (`${period} 周期${fieldName}均线`). English word order differs, so a
   lookup table cannot fix it; it needs per-locale sentence-building functions.

2. **`worker/strategy-api.ts`** — `detectOutputLanguage(intent)` (`:106`) changes
   to prefer an explicit `locale` in the request, with guessing only as a
   fallback, so the model's output language follows the UI rather than the input.
   **`STRATEGY_CACHE_VERSION` (`:10`) must be bumped** — the language semantics
   changed, so old cache entries cannot be reused (the version gate in
   `web/AGENTS.md`).

3. **`worker/backtest-api.ts`** — the error messages are all Chinese literals
   (for example "date range too large" at `:722`, and "the current web backtest
   data only contains OHLCV" at `:918`). They change to **a stable `code` plus
   parameters**, rendered by the frontend per locale, falling back to the
   server's own text for an unknown code. This matches the `AGENTS.md`
   requirement to implement reusable semantic primitives rather than binding to
   specific wording.

### 5.4 Other locale-related work

- `generateMetadata` in `app/layout.tsx` produces a per-locale title,
  description, and OG image (the existing `public/og-customer-journey.png` is in
  Chinese; English needs its own, or shares it for now with a to-do recorded).
- Numbers and dates: `backtest-workspace.tsx:214` hard-codes
  `Intl.DateTimeFormat("zh-CN", …)`, which becomes locale-driven.
- The language switcher goes in the global header; switching does a
  `router.replace` onto the same path with the other prefix, and for a logged-in
  user also writes back `users.locale`.

---

## 6. Implementation order

Five independently verifiable batches, each leaving the app in a working state:

| Batch | Contents | How it is verified |
|---|---|---|
| A | i18n skeleton: worker locale injection, the `[locale]` route segment, dictionaries, a bilingual `strategy-language.ts` renderer | Existing pages render contract rules correctly under both `/zh` and `/en` |
| B | Identity: users and auth_sessions tables, the three Google OAuth endpoints, cookie sessions, `pt_anon` | Sign in and out works, and `/api/auth/session` returns the right identity |
| C | Ownership: schema additions, server authorization from cookies, ignoring `sessionId` in the body, claim logic, tiered rate limits | Create a strategy anonymously → log in → it appears in the list; another session cannot read someone else's strategy |
| D | Information architecture: split landing page and workspace, four step routes, the stepper as navigation, the `confirm` endpoint and state restoration | Refreshing any step keeps progress, and links address a step |
| E | My Strategies page, account page, language switcher, bilingual API error codes | List, rename, delete, and continue all work |

Dependencies: A and B are independent; C depends on B; D depends on C (step 3
must gate on login); E depends on C and D. A and B can run in parallel.

### Gate reminders

Per `web/AGENTS.md`: a semantic change bumps the corresponding version (here
`STRATEGY_CACHE_VERSION`); one layer cannot support something the others do not
(locale must run through contract rendering, model output, error messages, and
cache keys); and `tests/rendered-html.test.mjs` depends on the home page's HTML
output, so it must be updated alongside the routing rework.

---

## 7. Not in this design

- Share links, subscription billing, and an asynchronous backtest queue (still
  open items in [project status](PROJECT_STATUS.md)).
- Email/password login and wallet binding (MVP items in `PRODUCT_SPEC.md` 5.1;
  this round is Google only).
- Any editing beyond renaming a strategy, and the strategy version-tree UI.
- An English OG image and English sample strategy content.

---

## 8. Where the implementation deviates from the design

Three things changed during implementation, all forced by the environment:

1. **Locale uses neither middleware nor a `[locale]` root layout.** The worker
   parses the locale from the pathname and injects `x-prooftrade-locale`;
   `app/layout.tsx` reads that header to set `<html lang>`, and page components
   read `params.locale`. Also, `app/[locale]/layout.tsx` cannot declare
   `generateStaticParams` — it conflicts with `dynamic = "force-dynamic"` and
   makes the whole tree fail to render.

2. **Dictionaries do not cross the server/client boundary.** Entries contain
   formatting functions, which are not serializable, so passing them as a prop to
   a client component makes RSC rendering fail outright. Client components now
   receive only the `locale` string and call `getMessages(locale)` themselves,
   which puts both dictionaries into the client bundle.

3. **Steps 3 and 4 share one component, dispatched by a `step` prop.** They share
   the backtest configuration, the parameter draft, and experiment state;
   splitting them would mean lifting all of that into a new container. Instead
   one component renders the appropriate half by `step`, and step 4 hydrates from
   the `backtest_runs` receipt, so the customer does not have to reconfigure the
   range and fees.

One server-side constraint that the design did not mention was also added: step 3
requires `confirmed_at` to exist, and a parameter-version strategy carries
`confirmed_at` from creation (its semantics are locked by the experiment, so the
model does not need to read it again).
