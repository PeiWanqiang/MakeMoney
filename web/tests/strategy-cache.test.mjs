import assert from "node:assert/strict";
import test from "node:test";

const artifact = {
  status: "ready",
  strategyName: "RSI 缓存测试",
  summary: "RSI 低于30时开固定金额多仓，高于55时平仓。",
  resolvedIntent: "1小时 RSI 策略",
  clarificationQuestions: [],
  unsupportedCapabilities: [],
  assumptions: [],
  warnings: [],
  contract: {
    schemaVersion: "1.0",
    timeframe: "1h",
    rules: [
      { when: ['position.side == "flat"', 'rsi("close",14,0) < 30'], decision: { type: "open", side: "long", sizeKind: "fixedNotional", sizeValue: 1000, stopLossPercent: 0.05, takeProfitRiskReward: null } },
      { when: ['position.side == "long"', 'rsi("close",14,0) > 55'], decision: { type: "close", side: null, sizeKind: null, sizeValue: null, stopLossPercent: null, takeProfitRiskReward: null } },
    ],
    unsupportedCapabilities: [],
  },
  source: "defineStrategy({ timeframe: '1h' })",
};

class Statement {
  constructor(sql, state) { this.sql = sql; this.state = state; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() {
    if (this.sql.includes("COUNT(*)")) return { count: 0 };
    if (this.sql.includes("FROM strategy_artifact_cache")) {
      const value = this.state.cache.get(this.args[0]);
      return value ? { result_json: value } : null;
    }
    return null;
  }
  async run() {
    if (this.sql.includes("INSERT INTO strategy_artifact_cache")) this.state.cache.set(this.args[0], this.args.at(-1));
    if (this.sql.includes("INSERT INTO strategy_submissions")) this.state.submissions.push(this.args);
    return { meta: { changes: 1 } };
  }
}

test("reuses a validated strategy artifact without a second model request", async () => {
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async (_url, init) => {
    modelCalls += 1;
    const requestBody = JSON.parse(init.body);
    assert.match(requestBody.messages[0].content, /all user-visible text must be written in the required output language/);
    assert.match(requestBody.messages[0].content, /market\.close <= highest\("high",100,1\) \* 0\.5/);
    assert.match(requestBody.messages[0].content, /sizeKind equityPercent with sizeValue 0\.5/);
    assert.match(requestBody.messages[1].content, /Required user-visible output language: Simplified Chinese \(zh-CN\)/);
    return Response.json({ id: "deepseek-1", choices: [{ message: { content: JSON.stringify(artifact) } }] });
  };
  try {
    const workerUrl = new URL(`../dist/server/index.js?strategy-cache=${Date.now()}`, import.meta.url);
    const { default: worker } = await import(workerUrl.href);
    const state = { cache: new Map(), submissions: [] };
    const DB = { prepare(sql) { return new Statement(sql, state); }, async batch() { return []; } };
    const request = (intent) => new Request("http://localhost/api/strategy/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent, asset: "BTCUSDT", market: "Binance Perpetual", sessionId: "session-1" }),
    });
    const firstResponse = await worker.fetch(request("1h RSI14 小于30做多固定1000美元，止损5%，RSI大于55平仓"), { DB, DEEPSEEK_API_KEY: "test" }, {});
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 200, JSON.stringify(first));
    assert.equal(first.generation.cacheStatus, "miss");
    assert.match(first.summary, /[\u3400-\u9fff]/);

    globalThis.fetch = async () => { throw new Error("model fetch must not run on a strategy-cache hit"); };
    const secondResponse = await worker.fetch(request("  1h RSI14 小于30做多固定1000美元，止损5%，RSI大于55平仓  "), { DB }, {});
    const second = await secondResponse.json();
    assert.equal(secondResponse.status, 200, JSON.stringify(second));
    assert.equal(second.generation.cacheStatus, "hit");
    assert.notEqual(first.id, second.id);
    assert.deepEqual(first.contract, second.contract);
    assert.equal(modelCalls, 1);
    assert.equal(state.submissions.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The strategy model reasons before answering and the token budget covers both,
// so a long enough chain of thought leaves the JSON cut off mid-string. That
// used to reach JSON.parse and surface as an opaque 500 saying nothing the
// customer could act on.
test("reports a truncated model answer as a retryable code, not an internal error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.ok(!String(url).includes("/v1/strategy/verify"), "a truncated answer must not reach the verify gate");
    assert.equal(JSON.parse(init.body).max_tokens, 16_000);
    return Response.json({
      id: "deepseek-3",
      choices: [{ message: { content: '{"status":"ready","strategyName":"截断' }, finish_reason: "length" }],
    });
  };
  try {
    const workerUrl = new URL(`../dist/server/index.js?truncated=${Date.now()}`, import.meta.url);
    const { default: worker } = await import(workerUrl.href);
    const state = { cache: new Map(), submissions: [] };
    const DB = { prepare(sql) { return new Statement(sql, state); }, async batch() { return []; } };
    const response = await worker.fetch(
      new Request("http://localhost/api/strategy/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "EMA20 上穿 EMA60 做多，止损5%，下穿平仓", asset: "BTCUSDT", market: "Binance Perpetual" }),
      }),
      { DB, DEEPSEEK_API_KEY: "test", BACKTEST_SERVICE_URL: "http://127.0.0.1:9" },
      {},
    );
    const body = await response.json();
    assert.equal(response.status, 502, JSON.stringify(body));
    assert.equal(body.code, "MODEL_RESPONSE_TRUNCATED");
    assert.equal(state.submissions.length, 0);
    assert.equal(state.cache.size, 0, "a truncated answer must not be cached");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The model reasons before it answers, so a budget that runs out mid-reasoning
// comes back as 200 with an empty content field. Reading that as "the model
// returned nothing" hid the one failure a bigger budget fixes behind an error
// the customer can do nothing about.
test("reports a budget exhausted during reasoning as truncation, not an empty result", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    id: "deepseek-4",
    choices: [{
      message: { content: "", reasoning_content: "用户要求中轨平一半……" },
      finish_reason: "length",
    }],
    usage: { completion_tokens: 16_000, completion_tokens_details: { reasoning_tokens: 16_000 } },
  });
  try {
    const workerUrl = new URL(`../dist/server/index.js?empty-truncated=${Date.now()}`, import.meta.url);
    const { default: worker } = await import(workerUrl.href);
    const state = { cache: new Map(), submissions: [] };
    const DB = { prepare(sql) { return new Statement(sql, state); }, async batch() { return []; } };
    const response = await worker.fetch(
      new Request("http://localhost/api/strategy/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "布林带下轨且RSI低于30做多，中轨平一半，上轨全平，1.5倍ATR止损", asset: "BTCUSDT", market: "Binance Perpetual" }),
      }),
      { DB, DEEPSEEK_API_KEY: "test", BACKTEST_SERVICE_URL: "http://127.0.0.1:9" },
      {},
    );
    const body = await response.json();
    assert.equal(response.status, 502, JSON.stringify(body));
    assert.equal(body.code, "MODEL_RESPONSE_TRUNCATED");
    assert.equal(response.headers.get("retry-after"), "5");
    assert.equal(state.submissions.length, 0);
    assert.equal(state.cache.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The gate is strict enough that one misplaced `undefined` check ends the
// request, and the fault is the model's, not the customer's wording. Handing the
// diagnostics back for one repair round is what the CLI studio has always done;
// without it the web path refused strategies the engine can run perfectly well.
test("repairs a rejected program once with the gate diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  const broken = { ...artifact, source: "defineStrategy({ /* prevClose possibly undefined */ })" };
  let modelCalls = 0;
  let verifyCalls = 0;
  let repairPrompt = "";
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/v1/strategy/verify")) {
      verifyCalls += 1;
      const source = JSON.parse(init.body).source;
      return source === broken.source
        ? Response.json({
          ok: false,
          compiled: { ok: false },
          semantics: { ok: false, scenarioCount: 0, scenarioPassed: 0 },
          diagnostics: [{ code: "TS18048", message: "'prevClose' is possibly 'undefined'." }],
        })
        : Response.json({ ok: true, compiled: { ok: true }, semantics: { ok: true, scenarioCount: 13, scenarioPassed: 13 } });
    }
    modelCalls += 1;
    const prompt = JSON.parse(init.body).messages[1].content;
    if (modelCalls === 1) return Response.json({ id: "deepseek-broken", choices: [{ message: { content: JSON.stringify(broken) } }] });
    repairPrompt = prompt;
    return Response.json({ id: "deepseek-repaired", choices: [{ message: { content: JSON.stringify(artifact) } }] });
  };
  try {
    const workerUrl = new URL(`../dist/server/index.js?repair=${Date.now()}`, import.meta.url);
    const { default: worker } = await import(workerUrl.href);
    const state = { cache: new Map(), submissions: [] };
    const DB = { prepare(sql) { return new Statement(sql, state); }, async batch() { return []; } };
    const response = await worker.fetch(
      new Request("http://localhost/api/strategy/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "1h RSI14 小于30做多固定1000美元，止损5%，RSI大于55平仓", asset: "BTCUSDT", market: "Binance Perpetual" }),
      }),
      { DB, DEEPSEEK_API_KEY: "test", BACKTEST_SERVICE_URL: "http://verify.test" },
      {},
    );
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(modelCalls, 2);
    assert.equal(verifyCalls, 2);
    assert.equal(body.generation.repairAttempts, 1);
    assert.equal(body.source, artifact.source, "the repaired program is what the customer receives");
    assert.match(repairPrompt, /TS18048/, "the repair round must carry the gate diagnostics");
    assert.match(repairPrompt, /Rejected program/);
    assert.equal(state.cache.size, 1);
    assert.equal(JSON.parse([...state.cache.values()][0]).source, artifact.source, "only the accepted program is banked");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Caching before the gate stored the rejected program under the customer's own
// words, so every retry of that description replayed the artifact the gate had
// already refused. "Please adjust and try again" was advice the cache made
// impossible to follow.
test("never banks an artifact the gate rejected, so retrying the same words can succeed", async () => {
  const originalFetch = globalThis.fetch;
  const broken = { ...artifact, source: "defineStrategy({ /* never compiles */ })" };
  let modelCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/v1/strategy/verify")) {
      return Response.json({
        ok: false,
        compiled: { ok: false },
        semantics: { ok: false, scenarioCount: 0, scenarioPassed: 0 },
        diagnostics: [{ code: "TS2322", message: "Type 'string' is not assignable to type 'number'." }],
      });
    }
    modelCalls += 1;
    return Response.json({ id: `deepseek-${modelCalls}`, choices: [{ message: { content: JSON.stringify(broken) } }] });
  };
  try {
    const workerUrl = new URL(`../dist/server/index.js?rejected=${Date.now()}`, import.meta.url);
    const { default: worker } = await import(workerUrl.href);
    const state = { cache: new Map(), submissions: [] };
    const DB = { prepare(sql) { return new Statement(sql, state); }, async batch() { return []; } };
    const response = await worker.fetch(
      new Request("http://localhost/api/strategy/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "1h RSI14 小于30做多固定1000美元，止损5%，RSI大于55平仓", asset: "BTCUSDT", market: "Binance Perpetual" }),
      }),
      { DB, DEEPSEEK_API_KEY: "test", BACKTEST_SERVICE_URL: "http://verify.test" },
      {},
    );
    const body = await response.json();
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal(body.code, "STRATEGY_PROGRAM_INVALID", "a program that never compiled is not a contract disagreement");
    assert.equal(modelCalls, 2, "the repair round runs before the request is refused");
    assert.equal(state.cache.size, 0, "a rejected artifact must never be replayed from cache");
    assert.equal(state.submissions.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The service is the only engine that runs a strategy, so an artifact it never
// verified can never become runnable. Persisting one anyway is what let a
// program the compiler rejects reach a confirmed strategy whose every backtest
// failed, so the outage has to surface here instead of at backtest time.
test("refuses to bank a ready artifact while the verify service is unreachable", async () => {
  const originalFetch = globalThis.fetch;
  let verifyCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/v1/strategy/verify")) {
      verifyCalls += 1;
      throw new TypeError("connection refused");
    }
    assert.match(JSON.parse(init.body).messages[0].content, /defineStrategy/);
    return Response.json({ id: "deepseek-2", choices: [{ message: { content: JSON.stringify(artifact) } }] });
  };
  try {
    const workerUrl = new URL(`../dist/server/index.js?verify-outage=${Date.now()}`, import.meta.url);
    const { default: worker } = await import(workerUrl.href);
    const state = { cache: new Map(), submissions: [] };
    const DB = { prepare(sql) { return new Statement(sql, state); }, async batch() { return []; } };
    const response = await worker.fetch(
      new Request("http://localhost/api/strategy/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "1h RSI14 小于30做多，止损5%，RSI大于55平仓", asset: "BTCUSDT", market: "Binance Perpetual" }),
      }),
      { DB, DEEPSEEK_API_KEY: "test", BACKTEST_SERVICE_URL: "http://127.0.0.1:9" },
      {},
    );
    const body = await response.json();
    assert.equal(response.status, 503, JSON.stringify(body));
    assert.equal(body.code, "STRATEGY_VERIFY_UNAVAILABLE");
    assert.equal(response.headers.get("retry-after"), "30");
    assert.equal(verifyCalls, 1);
    assert.equal(state.submissions.length, 0, "an unverified strategy must not be persisted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
