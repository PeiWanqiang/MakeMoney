import assert from "node:assert/strict";
import test from "node:test";

/**
 * Covers the identity boundary introduced with accounts:
 * steps 1–2 stay open, steps 3–4 require an account, and every owner id the
 * server trusts is derived from a cookie it issued rather than from the request.
 */

// The Worker only accepts a workspace cookie in the shape it issues, so the
// fixtures use realistic uuid-length values rather than short labels.
const ANON_A = "11111111-1111-4111-8111-111111111111";
const ANON_B = "22222222-2222-4222-8222-222222222222";

const SIGNED_IN_USER = { id: "user-1", email: "tester@example.com", display_name: "Tester", avatar_url: null, locale: "zh" };

const READY_STRATEGY = {
  status: "ready",
  strategyName: "RSI oversold",
  contract: {
    schemaVersion: "1.0",
    timeframe: "1h",
    rules: [
      { when: ['position.side == "flat"', "market.close < 100"], decision: { type: "open", side: "long", sizeKind: "fixedNotional", sizeValue: 1000, stopLossPercent: 0.5, takeProfitRiskReward: null } },
    ],
    unsupportedCapabilities: [],
  },
};

/**
 * A fake D1 that answers the session join only for a known token and applies the
 * ownership predicate literally, by matching the bound values against a row.
 */
function database({ sessionToken = null, strategyRow = null, existingUser = null, queries = [] } = {}) {
  /** Emulates `user_id = ? OR (user_id IS NULL AND session_id = ?)` over the bound values. */
  function ownerMatches(args) {
    const owners = [strategyRow.user_id, strategyRow.session_id].filter((value) => value !== null && value !== undefined);
    return args.some((value) => typeof value === "string" && owners.includes(value));
  }

  class Statement {
    constructor(sql) {
      this.sql = sql;
      this.args = [];
    }
    bind(...args) {
      this.args = args;
      return this;
    }
    async all() { return { results: [] }; }
    async run() {
      queries.push({ sql: this.sql, args: this.args });
      // Ownership-scoped updates must report zero changes for a stranger, which
      // is exactly how the handlers turn an unauthorised id into a 404.
      if (this.sql.includes("UPDATE strategy_submissions") && this.sql.includes("WHERE id = ?")) {
        return { meta: { changes: strategyRow && ownerMatches(this.args) ? 1 : 0 } };
      }
      return { meta: { changes: 1 } };
    }
    async first() {
      queries.push({ sql: this.sql, args: this.args });
      if (this.sql.includes("FROM auth_sessions")) {
        // The stored value is a hash of the cookie, so a request without the
        // right cookie simply finds nothing.
        return sessionToken ? { ...SIGNED_IN_USER } : null;
      }
      if (this.sql.includes("FROM users WHERE google_sub")) return existingUser;
      if (this.sql.includes("COUNT(*)")) return { count: 0 };
      if (this.sql.includes("FROM strategy_submissions")) {
        if (!strategyRow) return null;
        return ownerMatches(this.args) ? { ...strategyRow } : null;
      }
      return null;
    }
  }
  return { prepare: (sql) => new Statement(sql), async batch() { return []; } };
}

async function loadWorker(tag) {
  const url = new URL(`../dist/server/index.js?${tag}=${Date.now()}-${Math.random()}`, import.meta.url);
  const { default: worker } = await import(url.href);
  return worker;
}

async function post(worker, path, { body = {}, cookie, env = {}, headers = {} } = {}) {
  const response = await worker.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} },
  );
  return { response, payload: await response.json().catch(() => null) };
}

test("steps 1 and 2 stay open to anonymous visitors", async () => {
  const worker = await loadWorker("anon-analyze");
  const { response, payload } = await post(worker, "/api/strategy/analyze", {
    body: { intent: "在1小时K线上 RSI 低于 30 做多，风险 1%，止损 5%", asset: "BTCUSDT", market: "Binance Perpetual", locale: "zh" },
    cookie: `pt_anon=${ANON_A}`,
    env: { DB: database() },
  });
  // No model key is configured here, so the request reaches the model step and
  // stops there. What matters is that it was never rejected for lack of an account.
  assert.notEqual(payload.code, "AUTH_REQUIRED");
  assert.equal(response.status, 503);
  assert.equal(payload.code, "SERVICE_NOT_CONFIGURED");
});

test("steps 3 and 4 refuse anonymous callers on the server, not just in the UI", async () => {
  const worker = await loadWorker("anon-gate");
  for (const path of ["/api/backtest/run", "/api/optimization/run", "/api/optimization/blind", "/api/optimization/adopt"]) {
    const { response, payload } = await post(worker, path, {
      body: { strategyId: "strategy-1", optimizationId: "optimization-1" },
      cookie: `pt_anon=${ANON_A}`,
      env: { DB: database() },
    });
    assert.equal(response.status, 401, `${path} should require an account`);
    assert.equal(payload.code, "AUTH_REQUIRED");
  }
});

test("an anonymous visitor cannot reach a strategy owned by somebody else", async () => {
  const worker = await loadWorker("anon-isolation");
  const owned = { result_json: JSON.stringify(READY_STRATEGY), asset: "BTCUSDT", market: "Binance Perpetual", intent: "x", session_id: ANON_A, confirmed_at: null, user_id: null };

  // The creator can still record their own feedback.
  const mine = await post(worker, "/api/strategy/feedback", {
    body: { id: "strategy-1", feedback: "correct" },
    cookie: `pt_anon=${ANON_A}`,
    env: { DB: database({ strategyRow: owned }) },
  });
  assert.equal(mine.response.status, 200);

  // A different workspace cookie resolves to nothing at all.
  const theirs = await post(worker, "/api/strategy/feedback", {
    body: { id: "strategy-1", feedback: "correct" },
    cookie: `pt_anon=${ANON_B}`,
    env: { DB: database({ strategyRow: owned }) },
  });
  assert.equal(theirs.response.status, 404);
  assert.equal(theirs.payload.code, "NOT_FOUND");
});

test("a forged identity header cannot stand in for a session", async () => {
  const worker = await loadWorker("header-spoof");
  const { response, payload } = await post(worker, "/api/backtest/run", {
    body: { strategyId: "strategy-1" },
    cookie: `pt_anon=${ANON_A}`,
    headers: {
      "x-prooftrade-user-id": "user-1",
      "x-prooftrade-user-email": "attacker%40example.com",
    },
    env: { DB: database() },
  });
  assert.equal(response.status, 401);
  assert.equal(payload.code, "AUTH_REQUIRED");
});

test("Google sign-in uses PKCE and pins the state to a server-set cookie", async () => {
  const worker = await loadWorker("oauth-start");
  const response = await worker.fetch(
    new Request("http://localhost/api/auth/google/start?return_to=%2Fzh%2Fstrategies", { redirect: "manual" }),
    { DB: database(), GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret" },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin, "https://accounts.google.com");
  assert.equal(location.searchParams.get("client_id"), "client-id");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.ok(location.searchParams.get("code_challenge"));
  assert.equal(location.searchParams.get("redirect_uri"), "http://localhost/api/auth/google/callback");
  assert.equal(location.searchParams.get("scope"), "openid email profile");

  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /pt_oauth=/);
  assert.match(cookie, /HttpOnly/);
  const pending = JSON.parse(decodeURIComponent(/pt_oauth=([^;]+)/.exec(cookie)[1]));
  assert.equal(pending.state, location.searchParams.get("state"));
  assert.equal(pending.returnTo, "/zh/strategies");
});

test("an off-site return_to is refused and the callback rejects a mismatched state", async () => {
  const worker = await loadWorker("oauth-callback");
  const env = { DB: database(), GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret" };

  const offsite = await worker.fetch(
    new Request("http://localhost/api/auth/google/start?return_to=https%3A%2F%2Fevil.example%2Fx", { redirect: "manual" }),
    env,
    { waitUntil() {}, passThroughOnException() {} },
  );
  const pending = JSON.parse(decodeURIComponent(/pt_oauth=([^;]+)/.exec(offsite.headers.get("set-cookie"))[1]));
  assert.equal(pending.returnTo, "/");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("the token endpoint must not be called on a state mismatch"); };
  try {
    const response = await worker.fetch(
      new Request("http://localhost/api/auth/google/callback?code=abc&state=not-the-one", {
        headers: { cookie: `pt_oauth=${encodeURIComponent(JSON.stringify({ state: "real-state", verifier: "v", returnTo: "/zh" }))}` },
        redirect: "manual",
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} },
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/zh?auth_error=failed");
    // The pending cookie is cleared so a stale state cannot be replayed.
    assert.match(response.headers.get("set-cookie") ?? "", /pt_oauth=;.*Max-Age=0/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("signing in claims the work done anonymously on this device", async () => {
  const worker = await loadWorker("oauth-claim");
  const claims = [];
  const db = database({ sessionToken: "t", existingUser: { id: "user-1" } });
  const originalPrepare = db.prepare;
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    const originalRun = statement.run.bind(statement);
    statement.run = async () => {
      if (sql.includes("SET user_id = ?") && sql.includes("user_id IS NULL")) claims.push({ sql, args: statement.args });
      return originalRun();
    };
    return statement;
  };

  const originalFetch = globalThis.fetch;
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com",
    aud: "client-id",
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: "google-sub-1",
    email: "tester@example.com",
    email_verified: true,
    name: "Tester",
  })).toString("base64url");
  globalThis.fetch = async () => new Response(JSON.stringify({ id_token: `${header}.${body}.sig` }), { headers: { "content-type": "application/json" } });

  try {
    const response = await worker.fetch(
      new Request("http://localhost/api/auth/google/callback?code=abc&state=real-state", {
        headers: {
          cookie: `pt_anon=${ANON_A}; pt_oauth=${encodeURIComponent(JSON.stringify({ state: "real-state", verifier: "v", returnTo: "/zh/strategies" }))}`,
        },
        redirect: "manual",
      }),
      { DB: db, GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/zh/strategies");
    assert.match(response.headers.get("set-cookie") ?? "", /pt_session=/);
    // All three owned tables are claimed, and only their unowned rows.
    assert.deepEqual(
      claims.map((claim) => /UPDATE (\w+) SET/.exec(claim.sql)[1]).sort(),
      ["backtest_runs", "optimization_runs", "strategy_submissions"],
    );
    for (const claim of claims) assert.deepEqual(claim.args, ["user-1", ANON_A]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an id token minted for another client is refused", async () => {
  const worker = await loadWorker("oauth-audience");
  const originalFetch = globalThis.fetch;
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com",
    aud: "some-other-client",
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: "google-sub-2",
    email: "attacker@example.com",
  })).toString("base64url");
  globalThis.fetch = async () => new Response(JSON.stringify({ id_token: `${header}.${body}.sig` }), { headers: { "content-type": "application/json" } });

  try {
    const response = await worker.fetch(
      new Request("http://localhost/api/auth/google/callback?code=abc&state=real-state", {
        headers: { cookie: `pt_oauth=${encodeURIComponent(JSON.stringify({ state: "real-state", verifier: "v", returnTo: "/zh" }))}` },
        redirect: "manual",
      }),
      { DB: database(), GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    assert.equal(response.headers.get("location"), "/zh?auth_error=failed");
    assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /pt_session=/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
