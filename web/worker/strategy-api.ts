import { STRATEGY_SDK_DECLARATION } from "../../src/compiler/strategy-sdk-declaration.js";
import type { Identity } from "./auth";
import { sha256Text } from "./cache";
import { enforceEntryConditionFloor } from "./entry-condition-floor";
import { ensureOwnershipColumns } from "./schema-upgrade";

interface StrategyEnv {
  DB: D1Database;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_STRATEGY_MODEL?: string;
  /**
   * When set, `ready` artifacts must pass the service's program↔contract verify
   * gate (`POST /v1/strategy/verify`) before they are persisted as runnable.
   * Strategies that need data the Web pipeline cannot provide (funding/OI/etc.)
   * are downgraded to `unsupported` at analyze time instead of failing the
   * backtest with OHLCV_ONLY later. An unreachable service fails the request
   * rather than falling back, because an unverified program cannot become
   * runnable later — the service is the only engine that executes it.
   */
  BACKTEST_SERVICE_URL?: string;
}

/**
 * Bumped from `strategy-intent-v3-arithmetic-sizing` when the output language
 * stopped being guessed from the intent text and started following the UI locale:
 * a cached Chinese artifact must not be served to an English session.
 *
 * Bumped again when the prompt started carrying the Strategy SDK declaration:
 * artifacts cached under the old prompt were generated without a program shape
 * spec, so some of them do not compile and must never be replayed from cache.
 */
const STRATEGY_CACHE_VERSION = "strategy-intent-v6-sdk-declaration";
let strategySchemaReady: Promise<unknown> | null = null;

interface AnalyzeBody {
  intent?: unknown;
  asset?: unknown;
  market?: unknown;
  locale?: unknown;
}

const SYSTEM_PROMPT = `
You are ProofTrade's strategy-intent engine. Convert a user's crypto trading idea into an auditable product result. Never give investment advice, promise returns, or improve the strategy. Preserve the user's exact meaning and identify missing facts instead of guessing.

Choose exactly one status:
- ready: entry, direction, evaluation timeframe, position sizing and stop loss are all explicit enough to program.
- needs_clarification: the request is a strategy but execution-critical facts are missing or ambiguous.
- unsupported: the meaning is clear but requires capabilities outside OHLCV, funding rate, open interest, SMA, EMA, RSI, MACD, ATR, Bollinger Bands, highest/lowest, percent change, safe + - * / arithmetic, 1m/15m/1h/4h closed-bar data, long/short, fixed-notional/equity-percent/risk-percent sizing, percentage stop and risk/reward take profit.

Rules:
- all user-visible text must be written in the required output language supplied with the request. This includes strategyName, summary, resolvedIntent, clarificationQuestions, unsupportedCapabilities, assumptions and warnings;
- keep JSON keys, enum values, contract.when expressions and TypeScript source in their exact canonical technical syntax; do not translate them;
- when clarification is needed, ask concise, independently answerable questions, with exactly one missing decision per question;
- do not invent a timeframe, indicator period, threshold, direction, size, stop, take profit, cooldown, state or exit;
- level comparisons are not crossing events;
- for ready, output a StrategyContract and a complete defineStrategy TypeScript program that compiles against the SDK declaration below;
- for needs_clarification, source is empty, contract is null, clarificationQuestions is non-empty;
- for unsupported, source is empty, contract is null, unsupportedCapabilities is non-empty;
- assumptions describe only explicit interpretations, not invented trading rules;
- warnings should mention meaningful execution or data caveats.

The program is executed verbatim by the sandbox, so it must compile against this exact SDK. Do not invent any API outside the declaration and do not use a different program shape.

Strategy SDK declaration:
${STRATEGY_SDK_DECLARATION}

Program requirements, all mandatory:
- source contains exactly one defineStrategy({...}) expression and no Markdown fence;
- the definition object supplies id (stable slug), name, version (integer) and onBar;
- onBar receives the context and returns a StrategyDecision object; it never calls helpers such as openLong or closePosition, and it never declares indicators in a context field;
- read indicators through context.indicators.<name>(...) calls inside onBar, for example ctx.indicators.rsi("close", 14);
- indicator calls return number | null during warm-up: store the result in a local variable, check that variable for null once, and reuse the narrowed variable;
- signals come only from closed-bar context; execution occurs on the next bar;
- every open decision defines a positive stopLossPercent;
- never add network, files, time, randomness, exchange access, credentials, imports, loops, mutation, eval, or unsupported APIs.

A minimal well-formed program:
defineStrategy({
  id: "rsi.oversold.long",
  name: "RSI oversold long",
  version: 1,
  onBar(ctx) {
    const rsi = ctx.indicators.rsi("close", 14);
    if (rsi === null) return { type: "hold" };
    if (ctx.position.side === "flat" && rsi < 30) {
      return { type: "open", side: "long", size: { kind: "riskPercent", value: 0.01 }, stopLossPercent: 0.05 };
    }
    if (ctx.position.side === "long" && rsi > 55) return { type: "close", reason: "exit level reached" };
    return { type: "hold" };
  }
})

    The contract is an audit record consumed by a deterministic backtest interpreter. Use exact canonical conditions only:
    - position.side == "flat" (or "long" / "short")
    - market.close > ema("close",20,0)
    - rsi("close",14,0) < 30
    - atr(14,0) > 100
    - percentChange("close",20) < -0.05
    - macd("close",12,26,9,0).histogram > 0
    - bollingerBands("close",20,2,0).lower > market.close
    - highest("high",20,1) < market.close (lowest is also supported)
    - market.close <= highest("high",100,1) * 0.5
    - numeric operands may use parentheses and safe +, -, *, / arithmetic; never use arbitrary code or functions
    - crossAbove(ema("close",20,0),ema("close",20,1),ema("close",50,0),ema("close",50,1)); use crossBelow for the reverse
    - for a higher data timeframe, prefix every operand, for example timeframe("1h").rsi("close",14,0) < 30
    Never put prose, reasons, warm-up checks or invented aliases in contract.when. Percentages are decimal fractions: 1% is 0.01. Level comparisons are not crossing events. Every decision field is required and unused fields are null.
    Position sizing semantics are strict: "50% of account balance/equity as position notional" is sizeKind equityPercent with sizeValue 0.5; "risk 1% of account per trade" is riskPercent with sizeValue 0.01; an absolute quote-currency amount is fixedNotional. Never substitute one sizing meaning for another. A percentage take profit is represented as takeProfitRiskReward divided by stop loss: 10% take profit with 5% stop loss is 2.

    Return one JSON object only:
    {"status":"ready|needs_clarification|unsupported","strategyName":"short name","summary":"plain-language result","resolvedIntent":"string or null","clarificationQuestions":[],"unsupportedCapabilities":[],"assumptions":[],"warnings":[],"contract":{"schemaVersion":"1.0","timeframe":"1m|15m|1h|4h","rules":[{"when":["position.side == \\"flat\\"","rsi(\\"close\\",14,0) < 30"],"decision":{"type":"open|close","side":"long|short|null","sizeKind":"riskPercent|equityPercent|fixedNotional|null","sizeValue":0.01,"stopLossPercent":0.05,"takeProfitRiskReward":null}}],"unsupportedCapabilities":[]},"source":"defineStrategy({...}) or empty"}
`.trim();

async function ensureSchema(db: D1Database): Promise<void> {
  if (strategySchemaReady) {
    await strategySchemaReady;
    return;
  }
  strategySchemaReady = db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS strategy_submissions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      title TEXT,
      confirmed_at TEXT,
      archived_at TEXT,
      intent TEXT NOT NULL,
      market TEXT NOT NULL,
      asset TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT NOT NULL,
      result_json TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      feedback TEXT,
      feedback_note TEXT,
      feedback_at TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS strategy_submissions_session_idx ON strategy_submissions(session_id, created_at DESC)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS strategy_artifact_cache (
      cache_key TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      last_hit_at TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      result_json TEXT NOT NULL
    )`),
  ]).then(() => ensureOwnershipColumns(db)).catch((error) => {
    strategySchemaReady = null;
    throw error;
  });
  await strategySchemaReady;
}

function json(value: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...extraHeaders } });
}

/**
 * Errors travel as a stable `code` the browser renders in the active locale.
 * A rejection the caller may usefully repeat carries `Retry-After`, so clients
 * back off by a stated interval instead of guessing one.
 */
function fail(code: string, status: number, params?: Record<string, string | number>, retryAfterSeconds?: number): Response {
  return json({ error: code, code, params, retryAfterSeconds }, status,
    retryAfterSeconds === undefined ? undefined : { "retry-after": String(retryAfterSeconds) });
}

function cleanString(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

/**
 * Model output follows the interface language the customer is reading, not the
 * language they happened to type in. Detection from the intent text remains only
 * as a fallback for callers that do not send a locale.
 */
function outputLanguageFor(locale: string, intent: string): "zh-CN" | "en" {
  if (locale === "zh") return "zh-CN";
  if (locale === "en") return "en";
  return (intent.match(/[\u3400-\u9fff]/g)?.length ?? 0) >= 2 ? "zh-CN" : "en";
}

/**
 * Ownership predicate shared by every read of a strategy row.
 *
 * A signed-in user owns their claimed rows. An anonymous visitor may only reach
 * rows that are still unclaimed and were created by their own server-issued
 * workspace id \u2014 never a row that already belongs to an account.
 */
function ownershipClause(identity: Identity): { sql: string; bindings: string[] } {
  return identity.user
    ? { sql: "(user_id = ? OR (user_id IS NULL AND session_id = ?))", bindings: [identity.user.id, identity.anonId] }
    : { sql: "(user_id IS NULL AND session_id = ?)", bindings: [identity.anonId] };
}

function extractJson(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("模型返回格式无效");
  return parsed as Record<string, unknown>;
}

function validateArtifact(value: Record<string, unknown>): void {
  if (!["ready", "needs_clarification", "unsupported"].includes(String(value.status))) throw new Error("模型未返回有效处理状态");
  for (const field of ["clarificationQuestions", "unsupportedCapabilities", "assumptions", "warnings"]) {
    if (!Array.isArray(value[field]) || !(value[field] as unknown[]).every((item) => typeof item === "string")) throw new Error(`模型字段 ${field} 无效`);
  }
  if (value.status === "ready" && (!value.contract || typeof value.source !== "string" || !value.source.includes("defineStrategy"))) {
    throw new Error("模型没有生成完整策略制品");
  }
  if (value.status === "needs_clarification" && (value.clarificationQuestions as unknown[]).length === 0) throw new Error("模型没有提出必要问题");
  if (value.status === "unsupported" && (value.unsupportedCapabilities as unknown[]).length === 0) throw new Error("模型没有说明能力缺口");
}

/**
 * Capabilities the Web kline pipeline can actually feed the engine. Anything a
 * program needs beyond this (funding rate, open interest, mark price, turnover)
 * is intercepted at analyze time. Mirrors the service's default but stays
 * explicit here so the Web owns its data limitations.
 */
const VERIFY_AVAILABLE_CAPABILITIES = ["ohlcv", "indicators", "multiTimeframe", "state", "arithmetic"];

const CAPABILITY_LABELS: Record<string, { zh: string; en: string }> = {
  fundingRate: { zh: "资金费率数据", en: "funding rate data" },
  openInterest: { zh: "持仓量数据", en: "open interest data" },
  markPrice: { zh: "标记价格数据", en: "mark price data" },
  turnover: { zh: "成交额与主动买卖量数据", en: "quote/taker turnover data" },
};

function capabilityLabel(capability: string, outputLanguage: "zh-CN" | "en"): string {
  const entry = CAPABILITY_LABELS[capability];
  return entry ? (outputLanguage === "zh-CN" ? entry.zh : entry.en) : capability;
}

type VerifyCheck = { id: string; label: string; status: "passed" | "failed" | "not_applicable"; detail: string };

type VerifyGateResult =
  | { outcome: "passed"; check: VerifyCheck }
  | { outcome: "unsupported"; unsupported: string[]; check: VerifyCheck }
  | { outcome: "failed"; check: VerifyCheck }
  | { outcome: "unavailable"; check: VerifyCheck };

const verifyLabel = (outputLanguage: "zh-CN" | "en") =>
  outputLanguage === "zh-CN" ? "程序与契约一致性" : "Program and contract consistency";

/**
 * Runs the service verify gate for a `ready` artifact. Returns null when the
 * service is not configured; returns `unavailable` when the service cannot be
 * reached.
 *
 * `unavailable` used to fall back to the substring structural checks and still
 * persist the artifact as runnable. That is what let a program the compiler
 * rejects reach a confirmed strategy: the model emitted a different dialect,
 * the gate never ran, and every later backtest failed with COMPILE_FAILED
 * against a row the customer had already confirmed. Since the service is the
 * only execution engine, an unverified program has no way to become runnable
 * later, so analyze now refuses instead of banking a strategy that cannot run.
 */
async function verifyArtifact(
  env: StrategyEnv,
  artifact: Record<string, unknown>,
  outputLanguage: "zh-CN" | "en",
): Promise<VerifyGateResult | null> {
  if (!env.BACKTEST_SERVICE_URL) return null;
  const source = typeof artifact.source === "string" ? artifact.source : "";
  const contract = artifact.contract as Record<string, unknown> | null;
  if (!source || !contract) return { outcome: "failed", check: { id: "verify", label: verifyLabel(outputLanguage), status: "failed", detail: outputLanguage === "zh-CN" ? "策略程序缺失" : "Strategy program missing" } };
  const baseUrl = env.BACKTEST_SERVICE_URL.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/strategy/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "verify-1.0",
        source,
        contract: { ...contract, unsupportedCapabilities: Array.isArray(contract.unsupportedCapabilities) ? contract.unsupportedCapabilities : [] },
        availableCapabilities: VERIFY_AVAILABLE_CAPABILITIES,
      }),
    });
  } catch {
    return { outcome: "unavailable", check: { id: "verify", label: verifyLabel(outputLanguage), status: "not_applicable", detail: outputLanguage === "zh-CN" ? "一致性服务暂不可用，已使用基础检查" : "Consistency service unavailable; basic checks used" } };
  }
  if (!response.ok) {
    return { outcome: "unavailable", check: { id: "verify", label: verifyLabel(outputLanguage), status: "not_applicable", detail: outputLanguage === "zh-CN" ? "一致性服务暂不可用，已使用基础检查" : "Consistency service unavailable; basic checks used" } };
  }
  const payload = await response.json() as { ok?: boolean; capabilities?: { unsupported?: string[] }; diagnostics?: Array<{ code?: string }> };
  const unsupported = payload.capabilities?.unsupported ?? [];
  if (unsupported.length > 0) {
    const labels = unsupported.map((capability) => capabilityLabel(capability, outputLanguage));
    return {
      outcome: "unsupported",
      unsupported,
      check: { id: "verify", label: verifyLabel(outputLanguage), status: "failed", detail: outputLanguage === "zh-CN" ? `缺少数据能力：${labels.join("、")}` : `Missing data: ${labels.join(", ")}` },
    };
  }
  if (payload.ok === true) {
    return { outcome: "passed", check: { id: "verify", label: verifyLabel(outputLanguage), status: "passed", detail: outputLanguage === "zh-CN" ? "程序编译通过，契约核对与行为场景一致" : "Program compiles; contract matches with behavioral scenarios" } };
  }
  return { outcome: "failed", check: { id: "verify", label: verifyLabel(outputLanguage), status: "failed", detail: outputLanguage === "zh-CN" ? "程序与契约核对不一致" : "Program and contract are inconsistent" } };
}

function structuralChecks(artifact: Record<string, unknown>) {
  const source = typeof artifact.source === "string" ? artifact.source : "";
  const forbidden = ["fetch(", "XMLHttpRequest", "eval(", "new Function", "process.", "require(", "import ", "WebSocket"];
  const contract = artifact.contract as Record<string, unknown> | null;
  return [
    { id: "intent", label: "意图结构化", status: "passed", detail: "处理动作与解释字段完整" },
    {
      id: "contract",
      label: "契约结构门禁",
      status: artifact.status === "ready" && contract && Array.isArray(contract.rules) && contract.rules.length > 0 ? "passed" : artifact.status === "ready" ? "failed" : "not_applicable",
      detail: artifact.status === "ready" ? "规则、周期与决策字段已生成" : "当前处理动作不生成契约",
    },
    {
      id: "safety",
      label: "源码安全扫描",
      status: artifact.status === "ready" && forbidden.every((token) => !source.includes(token)) ? "passed" : artifact.status === "ready" ? "failed" : "not_applicable",
      detail: artifact.status === "ready" ? "未发现网络、进程、动态执行或导入调用" : "当前处理动作不生成程序",
    },
  ];
}

async function analyze(request: Request, env: StrategyEnv, identity: Identity): Promise<Response> {
  const body = await request.json() as AnalyzeBody;
  const intent = cleanString(body.intent, 5000);
  const asset = cleanString(body.asset, 32) || "BTCUSDT";
  const market = cleanString(body.market, 64) || "Binance Perpetual";
  const locale = cleanString(body.locale, 8);
  const outputLanguage = outputLanguageFor(locale, intent);
  const sessionId = identity.anonId || crypto.randomUUID();
  if (intent.length < 12) return fail("INTENT_TOO_SHORT", 400);
  if (/\b(?:sk-[a-z0-9_-]{12,}|seed phrase|private key|助记词|私钥)\b/i.test(intent)) return fail("SENSITIVE_CONTENT", 400);
  await ensureSchema(env.DB);
  // Anonymous visitors get a tighter hourly budget than accounts, because their
  // only cost barrier is a cookie.
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = identity.user
    ? await env.DB.prepare("SELECT COUNT(*) AS count FROM strategy_submissions WHERE user_id = ? AND created_at > ?")
      .bind(identity.user.id, since).first<{ count: number }>()
    : await env.DB.prepare("SELECT COUNT(*) AS count FROM strategy_submissions WHERE session_id = ? AND created_at > ?")
      .bind(sessionId, since).first<{ count: number }>();
  if ((recent?.count ?? 0) >= (identity.user ? 30 : 8)) return fail("RATE_LIMITED", 429);

  const started = Date.now();
  const model = env.DEEPSEEK_STRATEGY_MODEL || "deepseek-v4-pro";
  const normalizedIntent = intent.normalize("NFKC").replace(/\s+/g, " ").trim();
  const cacheKey = await sha256Text(`${STRATEGY_CACHE_VERSION}\n${model}\n${outputLanguage}\n${asset}\n${market}\n${normalizedIntent}`);
  const cached = await env.DB.prepare("SELECT result_json FROM strategy_artifact_cache WHERE cache_key = ?")
    .bind(cacheKey).first<{ result_json: string }>();

  let artifact: Record<string, unknown>;
  let responseId: string | null = null;
  let cacheStatus: "hit" | "miss" = "miss";
  if (cached) {
    artifact = JSON.parse(cached.result_json) as Record<string, unknown>;
    validateArtifact(artifact);
    enforceEntryConditionFloor(artifact, outputLanguage);
    cacheStatus = "hit";
    await env.DB.prepare("UPDATE strategy_artifact_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE cache_key = ?")
      .bind(new Date().toISOString(), cacheKey).run();
  } else {
    if (!env.DEEPSEEK_API_KEY) return fail("SERVICE_NOT_CONFIGURED", 503);
    const apiKey = env.DEEPSEEK_API_KEY.startsWith("sk-")
      ? env.DEEPSEEK_API_KEY
      : `sk-${env.DEEPSEEK_API_KEY}`;
    const response = await fetch(`${(env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Required user-visible output language: ${outputLanguage === "zh-CN" ? "Simplified Chinese (zh-CN)" : "English (en)"}\nAsset: ${asset}\nMarket: ${market}\n\nUser strategy intent:\n${intent}`,
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 5000,
        stream: false,
      }),
    });
    if (!response.ok) return fail("MODEL_UNAVAILABLE", 502);
    const completion = await response.json() as { id?: string; choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
    const content = completion.choices?.[0]?.message?.content;
    if (!content) return fail("EMPTY_MODEL_RESULT", 502);
    artifact = extractJson(content);
    validateArtifact(artifact);
    enforceEntryConditionFloor(artifact, outputLanguage);
    responseId = completion.id ?? null;
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO strategy_artifact_cache
      (cache_key, created_at, last_hit_at, hit_count, model, prompt_version, result_json)
      VALUES (?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET last_hit_at = excluded.last_hit_at, model = excluded.model,
        prompt_version = excluded.prompt_version, result_json = excluded.result_json`)
      .bind(cacheKey, now, now, model, STRATEGY_CACHE_VERSION, JSON.stringify(artifact)).run();
  }
  // Semantic admission gate: a `ready` artifact must pass the service's
  // program↔contract verification before it is persisted as runnable, so the
  // contract the customer confirms and the program that actually executes can
  // never drift apart. Only the substring structural checks fall back (service
  // unconfigured or unreachable).
  let verifyOutcome: VerifyGateResult | null = null;
  if (artifact.status === "ready") {
    verifyOutcome = await verifyArtifact(env, artifact, outputLanguage);
    if (verifyOutcome?.outcome === "failed") {
      return fail("STRATEGY_VERIFY_FAILED", 422);
    }
    // A `ready` artifact that was never verified cannot be persisted: the
    // service is the only engine, so an unverified program would surface as a
    // failed backtest long after the customer confirmed it. 503 with a retry
    // hint says the outage is ours and the request is worth repeating.
    if (verifyOutcome?.outcome === "unavailable") {
      return fail("STRATEGY_VERIFY_UNAVAILABLE", 503, undefined, 30);
    }
    if (verifyOutcome?.outcome === "unsupported") {
      const labels = verifyOutcome.unsupported.map((capability) => capabilityLabel(capability, outputLanguage));
      const existing = Array.isArray(artifact.unsupportedCapabilities)
        ? (artifact.unsupportedCapabilities as string[])
        : [];
      artifact = {
        ...artifact,
        status: "unsupported",
        unsupportedCapabilities: [...new Set([...existing, ...labels])],
      };
    }
  }
  const intentCheck: VerifyCheck = { id: "intent", label: "意图结构化", status: "passed", detail: "处理动作与解释字段完整" };
  // `failed` and `unavailable` already returned, so a gate result reaching here
  // is `passed` or `unsupported`. The structural fallback remains for artifacts
  // the gate never applies to: a non-`ready` status, or no service configured.
  const checks = verifyOutcome ? [intentCheck, verifyOutcome.check] : structuralChecks(artifact);
  const id = crypto.randomUUID();
  const latencyMs = Date.now() - started;
  const result = {
    id,
    status: artifact.status,
    strategyName: artifact.strategyName,
    summary: artifact.summary,
    resolvedIntent: artifact.resolvedIntent,
    clarificationQuestions: artifact.clarificationQuestions,
    unsupportedCapabilities: artifact.unsupportedCapabilities,
    assumptions: artifact.assumptions,
    warnings: artifact.warnings,
    contract: artifact.contract,
    source: artifact.source,
    checks,
    generation: { model, latencyMs, responseId, cacheStatus },
  };
  await env.DB.prepare(`INSERT INTO strategy_submissions
    (id, user_id, session_id, created_at, intent, market, asset, status, model, result_json, latency_ms, title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id,
      identity.user?.id ?? null,
      sessionId,
      new Date().toISOString(),
      intent,
      market,
      asset,
      String(artifact.status),
      model,
      JSON.stringify(result),
      latencyMs,
      cleanString(artifact.strategyName, 120) || null,
    ).run();
  return json(result);
}

async function feedback(request: Request, env: StrategyEnv, identity: Identity): Promise<Response> {
  const body = await request.json() as { id?: unknown; feedback?: unknown; note?: unknown };
  const id = cleanString(body.id, 96);
  const rating = cleanString(body.feedback, 16);
  const note = cleanString(body.note, 1000);
  if (!id || !["correct", "incorrect"].includes(rating)) return fail("BAD_REQUEST", 400);
  await ensureSchema(env.DB);
  const owner = ownershipClause(identity);
  const result = await env.DB.prepare(
    `UPDATE strategy_submissions SET feedback = ?, feedback_note = ?, feedback_at = ? WHERE id = ? AND ${owner.sql}`,
  ).bind(rating, note || null, new Date().toISOString(), id, ...owner.bindings).run();
  if (!result.meta.changes) return fail("NOT_FOUND", 404);
  return json({ ok: true });
}

/**
 * Records that the customer approved the machine reading of their strategy.
 * Persisting it is what lets the stepped routes survive a refresh — before this,
 * confirmation lived only in browser memory.
 */
async function confirm(request: Request, env: StrategyEnv, identity: Identity, id: string): Promise<Response> {
  await ensureSchema(env.DB);
  const owner = ownershipClause(identity);
  const row = await env.DB.prepare(`SELECT status, confirmed_at FROM strategy_submissions WHERE id = ? AND ${owner.sql}`)
    .bind(id, ...owner.bindings).first<{ status: string; confirmed_at: string | null }>();
  if (!row) return fail("NOT_FOUND", 404);
  if (row.status !== "ready") return fail("BAD_REQUEST", 400);
  if (row.confirmed_at) return json({ ok: true, confirmedAt: row.confirmed_at });

  const confirmedAt = new Date().toISOString();
  await env.DB.prepare("UPDATE strategy_submissions SET confirmed_at = ? WHERE id = ?").bind(confirmedAt, id).run();
  return json({ ok: true, confirmedAt });
}

async function rename(request: Request, env: StrategyEnv, identity: Identity, id: string): Promise<Response> {
  if (!identity.user) return fail("AUTH_REQUIRED", 401);
  const body = await request.json() as { title?: unknown };
  const title = cleanString(body.title, 120);
  if (!title) return fail("BAD_REQUEST", 400);
  await ensureSchema(env.DB);
  const result = await env.DB.prepare("UPDATE strategy_submissions SET title = ? WHERE id = ? AND user_id = ?")
    .bind(title, id, identity.user.id).run();
  if (!result.meta.changes) return fail("NOT_FOUND", 404);
  return json({ ok: true, title });
}

async function remove(env: StrategyEnv, identity: Identity, id: string): Promise<Response> {
  if (!identity.user) return fail("AUTH_REQUIRED", 401);
  await ensureSchema(env.DB);
  const result = await env.DB.prepare("UPDATE strategy_submissions SET archived_at = ? WHERE id = ? AND user_id = ? AND archived_at IS NULL")
    .bind(new Date().toISOString(), id, identity.user.id).run();
  if (!result.meta.changes) return fail("NOT_FOUND", 404);
  return json({ ok: true });
}

export interface StrategyListItem {
  id: string;
  title: string | null;
  asset: string;
  market: string;
  status: string;
  timeframe: string | null;
  createdAt: string;
  confirmedAt: string | null;
  lastBacktestAt: string | null;
  netReturn: number | null;
  maximumDrawdown: number | null;
  tradeCount: number | null;
  optimized: boolean;
}

interface StrategyListRow {
  id: string;
  title: string | null;
  asset: string;
  market: string;
  status: string;
  created_at: string;
  confirmed_at: string | null;
  result_json: string;
  last_backtest_at: string | null;
  backtest_json: string | null;
  backtest_trade_count: number | null;
  optimization_id: string | null;
}

/**
 * Reads the strategies owned by an account together with the most recent backtest
 * and optimisation for each, so the list can show real progress instead of just a
 * creation timestamp.
 */
export async function listStrategies(db: D1Database, userId: string, limit = 50): Promise<StrategyListItem[]> {
  await ensureSchema(db);
  const rows = await db.prepare(`
    SELECT s.id, s.title, s.asset, s.market, s.status, s.created_at, s.confirmed_at, s.result_json,
           b.created_at AS last_backtest_at, b.result_json AS backtest_json, b.trade_count AS backtest_trade_count,
           o.id AS optimization_id
    FROM strategy_submissions s
    LEFT JOIN backtest_runs b
      ON b.id = (SELECT id FROM backtest_runs WHERE strategy_submission_id = s.id ORDER BY created_at DESC LIMIT 1)
    LEFT JOIN optimization_runs o
      ON o.id = (SELECT id FROM optimization_runs WHERE strategy_submission_id = s.id ORDER BY created_at DESC LIMIT 1)
    WHERE s.user_id = ? AND s.archived_at IS NULL
    ORDER BY s.created_at DESC
    LIMIT ?
  `).bind(userId, limit).all<StrategyListRow>();

  return (rows.results ?? []).map((row) => {
    const artifact = safeParse(row.result_json);
    const backtest = row.backtest_json ? safeParse(row.backtest_json) : null;
    const metrics = (backtest?.metrics ?? null) as { netReturn?: number; maximumDrawdown?: number } | null;
    const contract = artifact?.contract as { timeframe?: string } | null | undefined;
    return {
      id: row.id,
      title: row.title || (typeof artifact?.strategyName === "string" ? artifact.strategyName : null),
      asset: row.asset,
      market: row.market,
      status: row.status,
      timeframe: contract?.timeframe ?? null,
      createdAt: row.created_at,
      confirmedAt: row.confirmed_at,
      lastBacktestAt: row.last_backtest_at,
      netReturn: typeof metrics?.netReturn === "number" ? metrics.netReturn : null,
      maximumDrawdown: typeof metrics?.maximumDrawdown === "number" ? metrics.maximumDrawdown : null,
      tradeCount: row.backtest_trade_count,
      optimized: Boolean(row.optimization_id),
    };
  });
}

function safeParse(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface StoredStrategy {
  id: string;
  asset: string;
  market: string;
  status: string;
  confirmedAt: string | null;
  title: string | null;
  intent: string;
  result: Record<string, unknown>;
  hasBacktest: boolean;
  hasOptimization: boolean;
}

/** Loads one strategy for a stepped route, enforcing the same ownership rule as the APIs. */
export async function loadStrategy(db: D1Database, identity: Identity, id: string): Promise<StoredStrategy | null> {
  await ensureSchema(db);
  const owner = ownershipClause(identity);
  const row = await db.prepare(`
    SELECT s.id, s.asset, s.market, s.status, s.confirmed_at, s.title, s.intent, s.result_json,
           (SELECT COUNT(*) FROM backtest_runs WHERE strategy_submission_id = s.id) AS backtest_count,
           (SELECT COUNT(*) FROM optimization_runs WHERE strategy_submission_id = s.id) AS optimization_count
    FROM strategy_submissions s
    WHERE s.id = ? AND s.archived_at IS NULL AND ${owner.sql}
  `).bind(id, ...owner.bindings).first<{
    id: string; asset: string; market: string; status: string; confirmed_at: string | null;
    title: string | null; intent: string; result_json: string;
    backtest_count: number; optimization_count: number;
  }>();
  if (!row) return null;
  const result = safeParse(row.result_json);
  if (!result) return null;
  return {
    id: row.id,
    asset: row.asset,
    market: row.market,
    status: row.status,
    confirmedAt: row.confirmed_at,
    title: row.title,
    intent: row.intent,
    result,
    hasBacktest: row.backtest_count > 0,
    hasOptimization: row.optimization_count > 0,
  };
}

export async function handleStrategyApi(request: Request, env: StrategyEnv, identity: Identity): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  try {
    if (pathname === "/api/strategy/analyze" && request.method === "POST") return await analyze(request, env, identity);
    if (pathname === "/api/strategy/feedback" && request.method === "POST") return await feedback(request, env, identity);
    if (pathname === "/api/strategy/list" && request.method === "GET") {
      if (!identity.user) return fail("AUTH_REQUIRED", 401);
      return json({ strategies: await listStrategies(env.DB, identity.user.id) });
    }
    if (pathname === "/api/strategy/health" && request.method === "GET") {
      return json({ ok: true, configured: Boolean(env.DEEPSEEK_API_KEY) });
    }

    const scoped = /^\/api\/strategy\/([A-Za-z0-9-]{8,96})\/(confirm|rename|delete)$/.exec(pathname);
    if (scoped) {
      const [, id, action] = scoped as unknown as [string, string, string];
      if (action === "confirm" && request.method === "POST") return await confirm(request, env, identity, id);
      if (action === "rename" && request.method === "POST") return await rename(request, env, identity, id);
      if (action === "delete" && request.method === "POST") return await remove(env, identity, id);
    }
    return null;
  } catch (error) {
    console.error("strategy api failure", error);
    return fail("INTERNAL_ERROR", 500);
  }
}
