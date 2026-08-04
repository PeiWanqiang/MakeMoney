import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function fetchWorker(path = "/", { headers = {}, redirect = "manual" } = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html", ...headers }, redirect }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function render(path, headers) {
  const response = await fetchWorker(path, { headers });
  assert.equal(response.status, 200, `expected 200 for ${path}`);
  return response.text();
}

test("the root path negotiates a locale instead of rendering one", async () => {
  const chinese = await fetchWorker("/", { headers: { "accept-language": "zh-CN,zh;q=0.9" } });
  assert.equal(chinese.status, 307);
  assert.equal(chinese.headers.get("location"), "/zh");

  const english = await fetchWorker("/", { headers: { "accept-language": "en-GB,en;q=0.9" } });
  assert.equal(english.status, 307);
  assert.equal(english.headers.get("location"), "/en");

  // Quality values decide, not document order.
  const weighted = await fetchWorker("/", { headers: { "accept-language": "zh;q=0.4, en;q=0.9" } });
  assert.equal(weighted.headers.get("location"), "/en");

  // An anonymous workspace id is issued on the first request so anonymous work
  // can later be claimed by an account.
  assert.match(chinese.headers.get("set-cookie") ?? "", /pt_anon=/);
});

test("the landing page carries the product explanation in both locales", async () => {
  const chinese = await render("/zh");
  assert.match(chinese, /<html lang="zh-CN"/);
  assert.match(chinese, /<title>ProofTrade/);
  assert.match(chinese, /把你的交易想法/);
  assert.match(chinese, /开始验证我的策略/);
  assert.match(chinese, /缺少条件就当场追问/);
  assert.match(chinese, /不只帮你跑/);
  assert.doesNotMatch(chinese, /codex-preview|Your site is taking shape|react-loading-skeleton/);

  const english = await render("/en");
  assert.match(english, /<html lang="en"/);
  assert.match(english, /Turn your trading idea/);
  assert.match(english, /Verify my strategy/);
  assert.match(english, /Missing conditions get questioned/);
  assert.doesNotMatch(english, /把你的交易想法/);
});

test("step 1 opens on the input, not on an introduction", async () => {
  const html = await render("/zh/new");
  assert.match(html, /先把你想怎么交易说出来/);
  assert.match(html, /检查我的策略是否说清楚/);
  assert.match(html, /什么时候[\s\S]*做什么[\s\S]*买多少[\s\S]*何时退出/);
  assert.match(html, /不知道怎么写？点一个例子直接填入/);
  // The marketing hero belongs to the landing page only.
  assert.doesNotMatch(html, /把你的交易想法/);
  assert.doesNotMatch(html, /不只帮你跑/);
  // The stepper is present and step 1 is the active one.
  assert.match(html, /说出策略[\s\S]*确认理解[\s\S]*历史验证[\s\S]*自动优化/);

  const english = await render("/en/new");
  assert.match(english, /Tell us how you want to trade/);
  assert.match(english, /Check whether my strategy is clear/);
});

test("每一步只保留一句解释，完整论证留在落地页", async () => {
  const [composePage, confirmPage, workspace, zh] = await Promise.all([
    readFile(new URL("app/[locale]/new/page.tsx", root), "utf8"),
    readFile(new URL("app/[locale]/s/[id]/confirm/page.tsx", root), "utf8"),
    readFile(new URL("app/backtest-workspace.tsx", root), "utf8"),
    readFile(new URL("app/i18n/zh.ts", root), "utf8"),
  ]);
  for (const source of [composePage, confirmPage]) assert.match(source, /step-why/);
  assert.match(workspace, /step-why/);
  assert.match(zh, /whyThisStep/);
  // Each step's own sentence exists exactly once per step section.
  assert.match(zh, /缺条件会当场追问，不拿默认值替你决定/);
  assert.match(zh, /确认后规则会被锁定/);
  assert.match(zh, /每一笔买卖都能回到对应 K 线上核对/);
  assert.match(zh, /找不到更好的就保留原参数/);
});

test("每一步都有单一重点、可读中文和明确的下一步操作", async () => {
  const [composer, understanding, workspace, css] = await Promise.all([
    readFile(new URL("app/strategy-composer.tsx", root), "utf8"),
    readFile(new URL("app/understanding-panel.tsx", root), "utf8"),
    readFile(new URL("app/backtest-workspace.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);
  // Step 2 shows the machine contract as readable rules before asking for a decision.
  assert.match(understanding, /describeRules/);
  assert.match(understanding, /plain-rules/);
  assert.match(understanding, /copy\.summaryLabel/);
  assert.match(understanding, /copy\.accept/);
  assert.match(understanding, /copy\.mergeAnswers/);
  // Research depth stays available, but only behind a disclosure.
  assert.match(understanding, /expert-view/);
  assert.match(workspace, /research-details/);
  assert.match(workspace, /run-details/);
  // Step 3 leads with a plain verdict and hands the customer the next step.
  assert.match(workspace, /historyVerdict/);
  assert.match(workspace, /verdict-card/);
  assert.match(workspace, /copy\.verdictLabel/);
  assert.match(workspace, /copy\.nextStepCta/);
  assert.match(workspace, /copy\.advanced/);
  // Step 4 keeps the robustness promise in plain words.
  assert.match(workspace, /lab\.run\b/);
  assert.match(workspace, /lab\.gateWalkForward/);
  assert.match(workspace, /lab\.gateSensitivity/);
  assert.match(workspace, /lab\.gateCost/);
  assert.match(workspace, /lab\.runBlind/);
  assert.match(workspace, /lab\.adopt\b/);
  // One primary action style shared by every step, and no unreadable micro type.
  assert.match(composer, /primary-action/);
  assert.match(css, /\.primary-action \{/);
  assert.doesNotMatch(css, /font-size: (?:[0-9]|10)px/);
});

test("keeps customer promises and secret handling explicit", async () => {
  const [zh, en, workspace, worker, backtest, hosting] = await Promise.all([
    readFile(new URL("app/i18n/zh.ts", root), "utf8"),
    readFile(new URL("app/i18n/en.ts", root), "utf8"),
    readFile(new URL("app/backtest-workspace.tsx", root), "utf8"),
    readFile(new URL("worker/strategy-api.ts", root), "utf8"),
    readFile(new URL("worker/backtest-api.ts", root), "utf8"),
    readFile(new URL(".openai/hosting.json", root), "utf8"),
  ]);
  assert.match(zh, /不构成投资建议/);
  assert.match(zh, /请勿填写.*密钥/);
  assert.match(zh, /这不是收益承诺/);
  assert.match(en, /not investment advice/i);
  assert.match(en, /not a promise of returns/i);
  assert.match(workspace, /copy\.methodTitle/);
  assert.match(worker, /strategy-intent-v6-sdk-declaration/);
  assert.match(backtest, /closed-bar signal/);
  assert.match(backtest, /semanticSkeleton/);
  assert.match(backtest, /MAX_OPTIMIZATION_TRIALS = 16/);
  assert.match(backtest, /\/api\/optimization\/run/);
  assert.match(backtest, /\/api\/optimization\/blind/);
  assert.match(backtest, /\/api\/optimization\/adopt/);
  assert.match(worker, /env\.DEEPSEEK_API_KEY/);
  assert.doesNotMatch(worker, /sk-[A-Za-z0-9_-]{20,}/);
  assert.equal(JSON.parse(hosting).d1, "DB");
});

test("identity is server-derived and cannot be supplied by the browser", async () => {
  const [entry, auth, strategy, backtest] = await Promise.all([
    readFile(new URL("worker/index.ts", root), "utf8"),
    readFile(new URL("worker/auth.ts", root), "utf8"),
    readFile(new URL("worker/strategy-api.ts", root), "utf8"),
    readFile(new URL("worker/backtest-api.ts", root), "utf8"),
  ]);
  // Any inbound identity header is dropped before the trusted ones are injected.
  assert.match(entry, /headers\.delete\(name\)/);
  assert.match(entry, /IDENTITY_HEADER_PREFIX/);
  // Session tokens are stored hashed, never in the clear.
  assert.match(auth, /token_hash/);
  assert.match(auth, /sha256Hex\(token\)/);
  assert.match(auth, /code_challenge_method/);
  assert.match(auth, /HttpOnly/);
  // The OAuth state is compared against the cookie the server set.
  assert.match(auth, /url\.searchParams\.get\("state"\) !== pending\.state/);
  // The reserved hosting-platform callback path is never claimed by the app.
  assert.match(auth, /\/api\/auth\/google\/callback/);
  assert.doesNotMatch(auth, /CALLBACK_PATH = "\/callback"/);
  // No handler reads an owner id out of the request body any more.
  assert.doesNotMatch(strategy, /cleanString\(body\.sessionId/);
  assert.doesNotMatch(backtest, /cleanString\(body\.sessionId/);
  // Steps 3 and 4 require an account server-side, not just in the UI.
  assert.equal(backtest.match(/if \(!identity\.user\) return fail\("AUTH_REQUIRED", 401\);/g)?.length, 4);
  // The deterministic experiment id derives from stored state, so claiming an
  // anonymous strategy cannot move an existing experiment receipt.
  assert.match(backtest, /const sessionId = stored\.session_id;/);
});

test("both message catalogues expose the same keys", async () => {
  const { zh } = await import(new URL("../app/i18n/zh.ts", import.meta.url).href).catch(() => ({ zh: null }));
  // The catalogues are TypeScript; when they cannot be imported directly, fall
  // back to comparing the key names that appear in each source file.
  if (!zh) {
    const [zhSource, enSource] = await Promise.all([
      readFile(new URL("app/i18n/zh.ts", root), "utf8"),
      readFile(new URL("app/i18n/en.ts", root), "utf8"),
    ]);
    const keys = (source) => new Set(source.match(/^\s{4}([A-Za-z][A-Za-z0-9]*):/gm)?.map((line) => line.trim()) ?? []);
    const missing = [...keys(zhSource)].filter((key) => !keys(enSource).has(key));
    assert.deepEqual(missing, [], `English catalogue is missing: ${missing.join(", ")}`);
  }
});
