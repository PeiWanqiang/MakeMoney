import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gzipSync, strToU8, zipSync } from "fflate";

const start = Date.UTC(2026, 0, 1);
const bars = [
  [start, "100", "101", "98", "99", "1000"],
  [start + 3_600_000, "100", "102", "99", "101", "1000"],
  [start + 7_200_000, "101", "107", "100", "106", "1000"],
  [start + 10_800_000, "107", "109", "106", "108", "1000"],
  [start + 14_400_000, "108", "110", "107", "109", "1000"],
];

const storedStrategy = {
  status: "ready",
  strategyName: "Close threshold test",
  contract: {
    schemaVersion: "1.0",
    timeframe: "1h",
    rules: [
      {
        when: ['position.side == "flat"', "market.close < 100"],
        decision: { type: "open", side: "long", sizeKind: "fixedNotional", sizeValue: 1000, stopLossPercent: 0.5, takeProfitRiskReward: null },
      },
      {
        when: ['position.side == "long"', "market.close > 105"],
        decision: { type: "close", side: null, sizeKind: null, sizeValue: null, stopLossPercent: null, takeProfitRiskReward: null },
      },
    ],
    unsupportedCapabilities: [],
  },
};

const optimizationBars = Array.from({ length: 120 }, (_, index) => {
  const close = 96 + Math.sin(index / 2) * 8 + index * 0.25;
  return [start + index * 3_600_000, String(close - 1), String(close + 2), String(close - 3), String(close), "1000"];
});

const SESSION_HEADERS = { "content-type": "application/json", cookie: "pt_session=test-token; pt_anon=session-1" };
const SIGNED_IN_USER = { id: "user-1", email: "tester@example.com", display_name: "Tester", avatar_url: null, locale: "zh" };

/**
 * Shared answers for the queries the identity and ownership layers issue before
 * a handler runs: the session join, the ownership-scoped strategy read, and the
 * additive column check.
 */
function identityRow(sql) {
  if (sql.includes("FROM auth_sessions")) return { ...SIGNED_IN_USER };
  return undefined;
}

const OWNED_STRATEGY_FIELDS = { session_id: "session-1", confirmed_at: "2026-01-01T00:00:00.000Z", intent: "价格低于阈值时做多" };

class Statement {
  constructor(sql, inserts, market, strategy) {
    this.sql = sql;
    this.inserts = inserts;
    this.market = market;
    this.strategy = strategy;
    this.args = [];
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async all() { return { results: [] }; }
  async first() {
    const identity = identityRow(this.sql);
    if (identity) return identity;
    if (this.sql.includes("COUNT(*)")) return { count: 0 };
    if (this.sql.includes("FROM strategy_submissions")) {
      return { result_json: JSON.stringify(this.strategy), asset: "BTCUSDT", market: this.market, ...OWNED_STRATEGY_FIELDS };
    }
    return null;
  }
  async run() {
    if (this.sql.includes("INSERT INTO backtest_runs")) this.inserts.push(this.args);
    if (this.sql.includes("optimization_runs") && this.sql.includes("INSERT")) this.inserts.push(this.args);
    return { meta: { changes: 1 } };
  }
}

class Bucket {
  constructor() { this.objects = new Map(); }
  async get(key) {
    const bytes = this.objects.get(key);
    return bytes ? { async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } } : null;
  }
  async put(key, value) {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.objects.set(key, bytes.slice());
  }
}

async function run(market, inserts = [], extraEnv = {}, range = {}, strategy = storedStrategy) {
  const workerUrl = new URL(`../dist/server/index.js?backtest=${Date.now()}-${Math.random()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const DB = {
    prepare(sql) { return new Statement(sql, inserts, market, strategy); },
    async batch() { return []; },
  };
  const response = await worker.fetch(new Request("http://localhost/api/backtest/run", {
    method: "POST",
    headers: SESSION_HEADERS,
    body: JSON.stringify({
      strategyId: "strategy-1",
      startTime: range.startTime ?? start,
      endTime: range.endTime ?? start + 14_400_000,
      initialCapital: 10_000,
      takerFeeRate: 0,
      slippageBps: 0,
      maxLeverage: 1,
    }),
  }), { DB, ...extraEnv }, {});
  return { response, result: await response.json(), inserts };
}

test("runs a confirmed contract against fetched klines and persists the receipt", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("external fetch must not run on a local-data hit"); };
  try {
    const inserts = [];
    const local = gzipSync(strToU8(JSON.stringify(bars)));
    const ASSETS = { async fetch() { return new Response(local); } };
    const { response, result } = await run("Binance Spot", inserts, { ASSETS });
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.barCount, 5);
    assert.equal(result.metrics.tradeCount, 1);
    assert.equal(result.trades[0].entryPrice, 100);
    assert.equal(result.trades[0].exitPrice, 107);
    assert.equal(result.finalEquity, 10_070);
    assert.equal(result.performance.klineCache.local, 1);
    assert.equal(inserts.length, 1);
    assert.equal(JSON.parse(inserts[0].at(-1)).bars, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("executes a percentage pullback with account-equity notional sizing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("external fetch must not run on a local-data hit"); };
  try {
    const pullbackBars = [
      [start, "90", "100", "88", "95", "1000"],
      [start + 3_600_000, "95", "120", "94", "110", "1000"],
      [start + 7_200_000, "110", "115", "99", "100", "1000"],
      [start + 10_800_000, "60", "61", "54", "55", "1000"],
      [start + 14_400_000, "50", "56", "49", "55", "1000"],
    ];
    const strategy = {
      status: "ready",
      strategyName: "100根高点回撤50%",
      contract: {
        schemaVersion: "1.0",
        timeframe: "1h",
        rules: [{
          when: ['position.side == "flat"', 'market.close <= highest("high",3,1) * (1 - 0.5)'],
          decision: { type: "open", side: "long", sizeKind: "equityPercent", sizeValue: 0.5, stopLossPercent: 0.05, takeProfitRiskReward: 2 },
        }],
        unsupportedCapabilities: [],
      },
    };
    const local = gzipSync(strToU8(JSON.stringify(pullbackBars)));
    const ASSETS = { async fetch() { return new Response(local); } };
    const { response, result } = await run("Binance Perpetual", [], { ASSETS }, {}, strategy);
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.metrics.tradeCount, 1);
    assert.equal(result.trades[0].entryPrice, 50);
    assert.equal(result.trades[0].quantity, 100);
    assert.equal(result.trades[0].exitPrice, 55);
    assert.equal(result.finalEquity, 10_500);
    assert.equal(result.engineVersion, "proof-worker-0.4.0");
    assert.equal(result.optimization.schemaVersion, "parameters-1.0");
    assert.equal(result.optimization.semanticLockHash.length, 64);
    assert.ok(result.optimization.parameters.some((parameter) => parameter.id === "rule.0.when.1.number.0"));
    assert.ok(result.optimization.parameters.some((parameter) => parameter.id === "rule.0.decision.stopLossPercent"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function optimize(strategy, parameters, options = {}) {
  const workerUrl = new URL(`../dist/server/index.js?optimization=${Date.now()}-${Math.random()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const inserts = [];
  const DB = {
    prepare(sql) { return new Statement(sql, inserts, "Binance Perpetual", strategy); },
    async batch() { return []; },
  };
  const local = gzipSync(strToU8(JSON.stringify(optimizationBars)));
  const ASSETS = { async fetch() { return new Response(local); } };
  const response = await worker.fetch(new Request("http://localhost/api/optimization/run", {
    method: "POST",
    headers: SESSION_HEADERS,
    body: JSON.stringify({
      strategyId: "strategy-1",
      startTime: start,
      endTime: start + 119 * 3_600_000,
      initialCapital: 10_000,
      takerFeeRate: 0,
      slippageBps: 0,
      maxLeverage: 1,
      objective: options.objective ?? "balanced",
      maxTrials: options.maxTrials ?? 8,
      parameters,
    }),
  }), { DB, ASSETS }, {});
  return { response, result: await response.json(), inserts };
}

test("runs a bounded parameter experiment while preserving the semantic lock", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("external fetch must not run during a local optimization"); };
  try {
    const parameters = [
      { id: "rule.0.when.1.number.0", min: 92, max: 106, steps: 5 },
      { id: "rule.0.decision.stopLossPercent", min: 0.25, max: 0.75, steps: 3 },
    ];
    const { response, result, inserts } = await optimize(storedStrategy, parameters);
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.schemaVersion, "optimization-2.0");
    assert.equal(result.semanticLockHash.length, 64);
    assert.equal(result.lockedSemantics.includes("比较符和布尔结构"), true);
    assert.ok(result.trials.length >= 6 && result.trials.length <= 8);
    assert.equal(result.trials[0].isBaseline, true);
    assert.equal(result.trials[0].parameters["rule.0.when.1.number.0"], 100);
    assert.equal(result.split.trainBars + result.split.validationBars + result.split.blindBars, 120);
    assert.equal(result.parameterSchema.length, 2);
    assert.ok(result.trials.some((trial) => trial.pareto));
    assert.equal(result.robustness.walkForward.folds.length, 3);
    assert.equal(result.robustness.costStress.points.length, 3);
    assert.ok(result.robustness.sensitivity.totalPoints >= 2);
    assert.equal(result.blindStatus, "reserved");
    // The experiment receipt now also records the owning account.
    assert.equal(inserts.some((args) => args.length === 9), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

class StageTwoStatement {
  constructor(sql, state) {
    this.sql = sql;
    this.state = state;
    this.args = [];
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async all() { return { results: [] }; }
  async first() {
    const identity = identityRow(this.sql);
    if (identity) return identity;
    if (this.sql.includes("FROM optimization_runs")) return { ...this.state.run, session_id: "session-1" };
    if (this.sql.includes("FROM strategy_submissions")) {
      return {
        result_json: JSON.stringify(this.state.strategy),
        asset: "BTCUSDT",
        market: "Binance Perpetual",
        ...OWNED_STRATEGY_FIELDS,
      };
    }
    return null;
  }
  async run() {
    if (this.sql.includes("SET blind_status = 'running'")) {
      const claimed = this.state.run.blind_status === "reserved";
      if (claimed) this.state.run.blind_status = "running";
      return { meta: { changes: claimed ? 1 : 0 } };
    }
    if (this.sql.includes("SET blind_status = ?, blind_consumed_at")) {
      const [status, consumedAt, receipt] = this.args;
      const claimed = this.state.run.blind_status === "running";
      if (claimed) {
        this.state.run.blind_status = status;
        this.state.run.blind_consumed_at = consumedAt;
        this.state.run.blind_result_json = receipt;
      }
      return { meta: { changes: claimed ? 1 : 0 } };
    }
    if (this.sql.includes("SET blind_status = 'reserved'")) {
      if (this.state.run.blind_status === "running") this.state.run.blind_status = "reserved";
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("SET adopted_strategy_id = ?")) {
      const [id] = this.args;
      const claimed = this.state.run.blind_status === "passed" && !this.state.run.adopted_strategy_id;
      if (claimed) this.state.run.adopted_strategy_id = id;
      return { meta: { changes: claimed ? 1 : 0 } };
    }
    if (this.sql.includes("SET adopted_strategy_id = NULL")) {
      this.state.run.adopted_strategy_id = null;
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO strategy_submissions")) {
      this.state.created.push(JSON.parse(this.args.at(-1)));
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 1 } };
  }
}

class ExperimentIdentityStatement {
  constructor(sql, state) {
    this.sql = sql;
    this.state = state;
    this.args = [];
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async all() { return { results: [] }; }
  async first() {
    const identity = identityRow(this.sql);
    if (identity) return identity;
    if (this.sql.includes("COUNT(*)")) return { count: 0 };
    if (this.sql.includes("FROM optimization_runs")) return this.state.run ? { ...this.state.run, session_id: "session-1" } : null;
    if (this.sql.includes("FROM strategy_submissions")) {
      return { result_json: JSON.stringify(storedStrategy), asset: "BTCUSDT", market: "Binance Perpetual", ...OWNED_STRATEGY_FIELDS };
    }
    return null;
  }
  async run() {
    if (this.sql.includes("optimization_runs") && this.sql.includes("INSERT")) {
      if (this.state.run) return { meta: { changes: 0 } };
      this.state.insertCount += 1;
      this.state.run = {
        id: this.args[0],
        strategy_submission_id: this.args[1],
        result_json: this.args.at(-1),
        blind_status: "reserved",
        blind_result_json: null,
        adopted_strategy_id: null,
      };
    }
    return { meta: { changes: 1 } };
  }
}

async function runIdentifiedExperiment(state) {
  const workerUrl = new URL(`../dist/server/index.js?identified=${Date.now()}-${Math.random()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const DB = {
    prepare(sql) { return new ExperimentIdentityStatement(sql, state); },
    async batch() { return []; },
  };
  const local = gzipSync(strToU8(JSON.stringify(optimizationBars)));
  const ASSETS = { async fetch() { return new Response(local); } };
  const response = await worker.fetch(new Request("http://localhost/api/optimization/run", {
    method: "POST",
    headers: SESSION_HEADERS,
    body: JSON.stringify({
      strategyId: "strategy-1",
      startTime: start,
      endTime: start + 119 * 3_600_000,
      initialCapital: 10_000,
      takerFeeRate: 0,
      slippageBps: 0,
      maxLeverage: 1,
      objective: "balanced",
      maxTrials: 8,
      parameters: [{ id: "rule.0.when.1.number.0", min: 92, max: 106, steps: 5 }],
    }),
  }), { DB, ASSETS }, {});
  return { response, result: await response.json() };
}

function stageTwoState(experiment, overrides = {}) {
  return {
    strategy: storedStrategy,
    created: [],
    assetReads: 0,
    run: {
      strategy_submission_id: "strategy-1",
      result_json: JSON.stringify(experiment),
      blind_status: "reserved",
      blind_result_json: null,
      blind_consumed_at: null,
      adopted_strategy_id: null,
      ...overrides,
    },
  };
}

async function stageTwoRequest(path, state) {
  const workerUrl = new URL(`../dist/server/index.js?stage-two=${Date.now()}-${Math.random()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const DB = {
    prepare(sql) { return new StageTwoStatement(sql, state); },
    async batch() { return []; },
  };
  const local = gzipSync(strToU8(JSON.stringify(optimizationBars)));
  const ASSETS = {
    async fetch() {
      state.assetReads += 1;
      return new Response(local);
    },
  };
  const response = await worker.fetch(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: SESSION_HEADERS,
    body: JSON.stringify({ optimizationId: "optimization-1" }),
  }), { DB, ASSETS }, {});
  return { response, result: await response.json() };
}

test("keeps the final holdout sealed until the generalized robustness gate passes", async () => {
  const parameters = [{ id: "rule.0.when.1.number.0", min: 92, max: 106, steps: 5 }];
  const { result: experiment } = await optimize(storedStrategy, parameters);
  const state = stageTwoState({ ...experiment, robustness: { ...experiment.robustness, preBlindPassed: false, failedChecks: ["walkForward"] } });
  const { response, result } = await stageTwoRequest("/api/optimization/blind", state);
  assert.equal(response.status, 409);
  assert.match(result.error, /保持封存/);
  assert.deepEqual(result.failedChecks, ["walkForward"]);
  assert.equal(state.run.blind_status, "reserved");
  assert.equal(state.assetReads, 0);
});

test("binds identical inputs to one experiment and preserves the consumed holdout state", async () => {
  const state = { run: null, insertCount: 0 };
  const first = await runIdentifiedExperiment(state);
  assert.equal(first.response.status, 200, JSON.stringify(first.result));
  assert.equal(state.insertCount, 1);
  const receipt = { schemaVersion: "blind-test-1.0", optimizationId: first.result.id, status: "failed", consumedAt: "2026-07-31T00:00:00.000Z" };
  state.run.blind_status = "failed";
  state.run.blind_result_json = JSON.stringify(receipt);

  const repeated = await runIdentifiedExperiment(state);
  assert.equal(repeated.response.status, 200, JSON.stringify(repeated.result));
  assert.equal(repeated.result.id, first.result.id);
  assert.equal(repeated.result.resultCache, "experiment-reused");
  assert.equal(repeated.result.blindStatus, "failed");
  assert.deepEqual(repeated.result.blindResult, receipt);
  assert.equal(state.insertCount, 1);
});

test("consumes the final holdout at most once and reuses its immutable receipt", async () => {
  const parameters = [{ id: "rule.0.when.1.number.0", min: 92, max: 106, steps: 5 }];
  const { result: original } = await optimize(storedStrategy, parameters);
  const changed = original.trials.find((trial) => !trial.isBaseline && trial.parameters[parameters[0].id] !== 100);
  assert.ok(changed);
  const experiment = {
    ...original,
    id: "optimization-1",
    outcome: "improved",
    recommendedTrialId: changed.id,
    robustness: { ...original.robustness, preBlindPassed: true, failedChecks: [] },
  };
  const state = stageTwoState(experiment);
  const first = await stageTwoRequest("/api/optimization/blind", state);
  assert.equal(first.response.status, 200, JSON.stringify(first.result));
  assert.match(first.result.status, /^(passed|failed)$/);
  assert.equal(first.result.reused, false);
  assert.equal(first.result.blindWindow.bars, 24);
  assert.equal(state.assetReads, 1);
  const second = await stageTwoRequest("/api/optimization/blind", state);
  assert.equal(second.response.status, 200, JSON.stringify(second.result));
  assert.equal(second.result.reused, true);
  assert.equal(second.result.consumedAt, first.result.consumedAt);
  assert.deepEqual(second.result.candidate, first.result.candidate);
  assert.equal(state.assetReads, 1);
});

test("creates one immutable contract-derived version only after a passed blind test", async () => {
  const parameters = [{ id: "rule.0.when.1.number.0", min: 92, max: 106, steps: 5 }];
  const { result: original } = await optimize(storedStrategy, parameters);
  const changed = original.trials.find((trial) => !trial.isBaseline && trial.parameters[parameters[0].id] !== 100);
  assert.ok(changed);
  const experiment = {
    ...original,
    id: "optimization-1",
    outcome: "improved",
    recommendedTrialId: changed.id,
    robustness: { ...original.robustness, preBlindPassed: true, failedChecks: [] },
  };
  const blockedState = stageTwoState(experiment);
  const blocked = await stageTwoRequest("/api/optimization/adopt", blockedState);
  assert.equal(blocked.response.status, 409);
  assert.equal(blockedState.created.length, 0);

  const state = stageTwoState(experiment, { blind_status: "passed" });
  const first = await stageTwoRequest("/api/optimization/adopt", state);
  assert.equal(first.response.status, 200, JSON.stringify(first.result));
  assert.equal(first.result.reused, false);
  assert.equal(state.created.length, 1);
  const artifact = state.created[0];
  assert.equal(artifact.parentStrategyId, "strategy-1");
  assert.equal(artifact.optimizationId, "optimization-1");
  assert.equal(artifact.programStatus, "contract-derived");
  assert.equal(artifact.contract.timeframe, storedStrategy.contract.timeframe);
  assert.equal(artifact.contract.rules[0].decision.type, storedStrategy.contract.rules[0].decision.type);
  assert.notEqual(artifact.contract.rules[0].when[1], storedStrategy.contract.rules[0].when[1]);
  assert.equal(artifact.semanticLockHash, original.semanticLockHash);

  const second = await stageTwoRequest("/api/optimization/adopt", state);
  assert.equal(second.response.status, 200, JSON.stringify(second.result));
  assert.equal(second.result.reused, true);
  assert.equal(second.result.id, first.result.id);
  assert.equal(state.created.length, 1);
});

test("extracts indicator periods but keeps lag offsets out of the tunable schema", async () => {
  const indicatorStrategy = {
    ...storedStrategy,
    contract: {
      ...storedStrategy.contract,
      rules: [{
        when: ['position.side == "flat"', 'rsi("close",14,0) < 30'],
        decision: storedStrategy.contract.rules[0].decision,
      }],
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("external fetch must not run on local data"); };
  try {
    const localRows = Array.from({ length: 20 }, (_, index) => [start + index * 3_600_000, "100", "106", "96", String(100 + index % 4), "1000"]);
    const local = gzipSync(strToU8(JSON.stringify(localRows)));
    const ASSETS = { async fetch() { return new Response(local); } };
    const { response, result } = await run("Binance Perpetual", [], { ASSETS }, { endTime: start + 19 * 3_600_000 }, indicatorStrategy);
    assert.equal(response.status, 200, JSON.stringify(result));
    const conditions = result.optimization.parameters.filter((parameter) => parameter.id.includes("when.1"));
    assert.deepEqual(conditions.map((parameter) => parameter.value), [14, 30]);
    assert.equal(conditions[0].unit, "bars");
    assert.equal(conditions.some((parameter) => parameter.value === 0), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps arithmetic identity constants locked while exposing the actual pullback ratio", async () => {
  const pullbackStrategy = {
    ...storedStrategy,
    contract: {
      ...storedStrategy.contract,
      rules: [{
        when: ['position.side == "flat"', 'market.close <= highest("high",20,1) * (1 - 0.4)'],
        decision: storedStrategy.contract.rules[0].decision,
      }],
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("external fetch must not run on local data"); };
  try {
    const localRows = Array.from({ length: 30 }, (_, index) => [start + index * 3_600_000, "100", "110", "80", String(95 + index % 5), "1000"]);
    const local = gzipSync(strToU8(JSON.stringify(localRows)));
    const ASSETS = { async fetch() { return new Response(local); } };
    const { response, result } = await run("Binance Perpetual", [], { ASSETS }, { endTime: start + 29 * 3_600_000 }, pullbackStrategy);
    assert.equal(response.status, 200, JSON.stringify(result));
    const values = result.optimization.parameters.filter((parameter) => parameter.id.includes("when.1")).map((parameter) => parameter.value);
    assert.deepEqual(values, [20, 0.4]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects unknown parameter ids before any experiment executes", async () => {
  const { response, result } = await optimize(storedStrategy, [{ id: "rule.99.magic", min: 1, max: 2, steps: 3 }]);
  assert.equal(response.status, 400);
  assert.match(result.error, /未知或重复/);
});

/** An oscillating year of hourly bars, long enough to force equity decimation. */
const LONG_BAR_COUNT = 2_000;
const longBars = Array.from({ length: LONG_BAR_COUNT }, (_, index) => {
  const close = 102 + Math.sin(index / 9) * 7 + Math.sin(index / 140) * 4;
  return [start + index * 3_600_000, String(close - 0.5), String(close + 1.5), String(close - 1.5), String(close), "1000"];
});
const longRange = { startTime: start, endTime: start + (LONG_BAR_COUNT - 1) * 3_600_000 };

function longHistoryAssets() {
  const blob = gzipSync(strToU8(JSON.stringify(longBars)));
  return { async fetch() { return new Response(blob); } };
}

/** Mirrors the server's own drawdown walk, so the two can be compared. */
function maximumDrawdownOf(curve, initialCapital) {
  let peak = initialCapital;
  let worst = 0;
  for (const [, equity] of curve) {
    peak = Math.max(peak, equity);
    worst = Math.min(worst, peak > 0 ? equity / peak - 1 : 0);
  }
  return worst;
}

test("sends both chart series as numeric rows and decimates the equity curve", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("external fetch must not run on a local-data hit"); };
  try {
    const { response, result } = await run("Binance Spot", [], { ASSETS: longHistoryAssets() }, longRange);
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.barCount, LONG_BAR_COUNT);

    assert.deepEqual(result.series, {
      bars: ["timestamp", "open", "high", "low", "close"],
      equityCurve: ["timestamp", "equity"],
    });
    assert.equal(result.bars.length, LONG_BAR_COUNT);
    assert.equal(result.bars[0].length, 5, "bars travel as rows, not objects");
    assert.equal(result.bars[0][0], start);

    // The curve has a point per bar before transport and is cut to what the
    // chart can resolve; the response states the original count either way.
    assert.equal(result.equityCurvePoints, LONG_BAR_COUNT);
    assert.ok(result.equityCurve.length <= 1_500, `curve kept ${result.equityCurve.length} points`);
    assert.ok(result.equityCurve.length < LONG_BAR_COUNT, "a 2,000-bar curve must actually be decimated");
    assert.equal(result.equityCurve[0].length, 2);

    // Timestamps stay ordered, and the trough behind the reported drawdown
    // survives — a plain stride could have stepped over it.
    const timestamps = result.equityCurve.map(([timestamp]) => timestamp);
    assert.deepEqual(timestamps, [...timestamps].sort((left, right) => left - right));
    assert.equal(
      maximumDrawdownOf(result.equityCurve, result.config.initialCapital).toFixed(10),
      result.metrics.maximumDrawdown.toFixed(10),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reuses one cached result for end times that land inside the same bar", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("external fetch must not run on a local-data hit"); };
  try {
    const CACHE = new Bucket();
    const ASSETS = longHistoryAssets();
    const first = await run("Binance Spot", [], { ASSETS, CACHE }, longRange);
    assert.equal(first.response.status, 200, JSON.stringify(first.result));
    assert.equal(first.result.performance.resultCache, "miss");

    // Same closed bar, a different millisecond inside it. Before the window was
    // aligned this minted a fresh cache key and re-ran the whole backtest — and
    // it is the request the workspace sends whenever the end date is today,
    // because the server then falls back to `now - one interval`.
    const later = await run("Binance Spot", [], { ASSETS, CACHE }, { ...longRange, endTime: longRange.endTime + 2_137 });
    assert.equal(later.response.status, 200, JSON.stringify(later.result));
    assert.equal(later.result.performance.resultCache, "persistent-hit");
    assert.equal(later.result.barCount, first.result.barCount);
    assert.equal(later.result.finalEquity, first.result.finalEquity);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a full compute queue answers 429 with a retry hint rather than waiting", async () => {
  const workerUrl = new URL(`../dist/server/index.js?busy=${Date.now()}-${Math.random()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("external fetch must not run on a local-data hit"); };
  try {
    const DB = { prepare(sql) { return new Statement(sql, [], "Binance Spot", storedStrategy); }, async batch() { return []; } };
    const env = { DB, ASSETS: longHistoryAssets(), CACHE: new Bucket() };
    // The gate admits six and queues twenty-four; the rest are turned away.
    // Each request carries its own range so none of them can be served from a
    // cache entry another one just wrote.
    const responses = await Promise.all(Array.from({ length: 40 }, (_, index) => worker.fetch(new Request("http://localhost/api/backtest/run", {
      method: "POST",
      headers: SESSION_HEADERS,
      body: JSON.stringify({
        strategyId: "strategy-1",
        startTime: start,
        endTime: longRange.endTime - index * 3_600_000,
        initialCapital: 10_000 + index,
        takerFeeRate: 0,
        slippageBps: 0,
        maxLeverage: 1,
      }),
    }), env, {})));

    const busy = responses.filter((response) => response.status === 429);
    assert.ok(busy.length > 0, "40 concurrent backtests must overflow a gate that holds 30");
    assert.equal(busy[0].headers.get("retry-after"), "2");
    assert.equal((await busy[0].json()).code, "SERVER_BUSY");
    assert.ok(responses.some((response) => response.status === 200), "admitted requests still succeed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cold-starts from official Binance archives and persists both data and result caches", async () => {
  const originalFetch = globalThis.fetch;
  const csv = [
    "open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore",
    ...bars.map((row) => [...row, row[0] + 3_599_999, "0", "0", "0", "0", "0"].join(",")),
  ].join("\n");
  const archive = zipSync({ "BTCUSDT-1h-2026-01.csv": strToU8(csv) });
  let externalCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://data.binance.vision/data/futures/um/monthly/")) {
      externalCalls += 1;
      return new Response(archive);
    }
    return originalFetch(input);
  };
  try {
    const CACHE = new Bucket();
    const { response, result } = await run("Binance Perpetual", [], { CACHE });
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.barCount, 5);
    assert.match(result.dataSource, /已写入 ProofTrade 本地缓存/);
    assert.equal(result.metrics.tradeCount, 1);
    assert.equal(externalCalls, 1);

    globalThis.fetch = async () => { throw new Error("external fetch must not run on a persistent-cache hit"); };
    const second = await run("Binance Perpetual", [], { CACHE });
    assert.equal(second.response.status, 200, JSON.stringify(second.result));
    assert.equal(second.result.performance.klineCache.object, 1);
    assert.equal(second.result.performance.resultCache, "persistent-hit");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizes microsecond timestamps from Binance spot archives", async () => {
  const originalFetch = globalThis.fetch;
  const csv = bars.map((row) => [row[0] * 1000, ...row.slice(1), row[0] * 1000 + 3_599_999_999, "0", "0", "0", "0", "0"].join(",")).join("\n");
  const archive = zipSync({ "BTCUSDT-1h-2026-01.csv": strToU8(csv) });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://data.binance.vision/data/spot/monthly/")) return new Response(archive);
    return originalFetch(input);
  };
  try {
    const { response, result } = await run("Binance Spot");
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.bars[0][0], start);
    assert.equal(result.barCount, 5);
    assert.match(result.dataSource, /官方历史归档/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("serves the customer-reported one-year BTC range entirely from bundled local history", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("external fetch must not run for bundled BTC history"); };
  try {
    const ASSETS = {
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        try {
          return new Response(await readFile(new URL(`../public${pathname}`, import.meta.url)));
        } catch {
          return new Response("Not found", { status: 404 });
        }
      },
    };
    const range = { startTime: Date.UTC(2025, 6, 30), endTime: Date.UTC(2026, 6, 31) - 1 };
    const { response, result } = await run("Binance Perpetual", [], { ASSETS }, range);
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.barCount, 8_784);
    assert.equal(result.performance.klineCache.local, 13);
    assert.equal(result.performance.klineCache.external, 0);
    assert.match(result.dataSource, /ProofTrade 本地历史库/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
