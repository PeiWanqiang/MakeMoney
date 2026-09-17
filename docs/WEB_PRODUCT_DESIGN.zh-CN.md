# Web 产品形态设计：登录、分步链路、我的策略、中英文

状态：Design v1 —— 已按本文实现（2026-08-01）。与设计的偏差记在第 8 节。
关联：[产品规格](PRODUCT_SPEC.zh-CN.md)｜[项目状态](PROJECT_STATUS.zh-CN.md)｜[泛化优先准入规范](GENERALIZATION_POLICY.zh-CN.md)

本文覆盖 [项目状态 2.8](PROJECT_STATUS.zh-CN.md) 里那条唯一未完成项：**「登录、对象所有权、分享、订阅、计费和异步回测任务尚未完成」** 中的登录与对象所有权部分，外加信息架构重构和国际化。

已确认的四个决策：Google 账户登录 · 匿名可用到第 2 步、回测前拦登录 · `/zh` `/en` URL 前缀 · 分步路由每次只渲染当前步。

---

## 1. 现状问题

代码事实（`web/app/page.tsx` 597 行 + `web/app/backtest-workspace.tsx` 1000+ 行）：

1. **整个产品是一个路由 `/`**。营销内容（hero、四步说明、为什么可信、结尾 CTA）和四步工作流串在同一条长页面上，靠 `#workspace` `#backtest` 锚点跳转。
2. **第 1 步的首屏是营销内容**，不是输入框。用户要滚过一整屏才能开始干活，而顶部 stepper 已经把「说出策略」标成"进行中"——进度条说你在干活，页面却在做自我介绍。
3. **状态全在 React 内存里**。`result`、`confirmed`、`milestone` 都是 `useState`，刷新即丢，链接无法定位到任何中间步骤，也无法分享。
4. **没有用户**。身份是 localStorage 里一个 `crypto.randomUUID()`，作为 `sessionId` 放在**请求体**里传给服务端，服务端用 `WHERE id = ? AND session_id = ?` 当授权。换设备、清缓存、换浏览器就全部丢失。
5. **语言是硬编码中文**，只有澄清问答那几处用 `usesChinese(intent)` 猜语言（`page.tsx:84`），是个临时补丁；服务端 `detectOutputLanguage` 同样靠猜。渲染器 `strategy-language.ts` 的全部标签、`backtest-api.ts` 的全部报错文案都是中文字面量。

---

## 2. 目标信息架构

### 2.1 路由表

```
/                                  → 302，按 Accept-Language 到 /zh 或 /en

/[locale]                          落地页（匿名）：介绍 + 登录 + 直接开始
/[locale]/new                      第 1 步 · 说出策略（匿名可用，纯输入无营销）
/[locale]/s/[id]                   → 302 到该策略当前应处的步骤
/[locale]/s/[id]/confirm           第 2 步 · 确认理解（匿名可用）
/[locale]/s/[id]/backtest          第 3 步 · 历史验证（需登录）
/[locale]/s/[id]/optimize          第 4 步 · 自动优化（需登录）
/[locale]/strategies               我的策略（需登录）
/[locale]/account                  账号：语言偏好、登出、删除数据

/api/auth/google/start             发起 Google OAuth
/api/auth/google/callback          OAuth 回调
/api/auth/signout                  登出
/api/auth/session                  当前身份（供客户端组件读取）
```

保留路径警告：OpenAI Sites 平台占用 `/signin-with-chatgpt`、`/signout-with-chatgpt`、`/callback`（见 `web/README.md`）。**Google 回调不能放 `/callback`**，必须走 `/api/auth/google/callback`。

### 2.2 营销内容如何打散

现在整屏的 `proof-section` 四条论证，拆成两份：

| 原内容 | 去处 |
|---|---|
| hero 标题 + 副文案 + 四步卡片 | 落地页 `/[locale]`，只在这里出现一次 |
| 「不替你猜，缺条件当场追问」 | 第 1 步页头一行副标题 |
| 「你确认后才开始回测，规则被锁定」 | 第 2 步页头一行副标题 + 确认按钮旁的说明 |
| 「每笔可回看，收益曲线不是唯一答案」 | 第 3 步页头一行副标题 |
| 「找不到更好的就保留原参数，证明更优不是运气」 | 第 4 步页头一行副标题 |
| 「不构成投资建议」免责 | 全局 footer + 第 1 步输入框下方（保留现有 `privacy-note`） |

原则：**每一步只保留一句话解释这一步为什么存在**，其余论证留在落地页。工作台里不再出现整屏营销区块。

### 2.3 stepper 变成导航

顶部四步进度条从"装饰性状态显示"改为**真实路由导航**：已完成的步骤可点击回看（`<Link>`），未解锁的步骤禁用。当前步骤高亮。这样"第 1 步在读介绍"的错位消失——每一步的 URL、进度条状态和页面内容三者一致。

已完成步骤在下方折叠成一行摘要卡（例如第 2 步完成后显示「已确认：RSI 低于 30 做多，止损 5% · 展开」），点击展开原内容，不占据滚动高度。

### 2.4 状态持久化

分步路由要求状态在服务端。策略记录已经存在 D1（`strategy_submissions`），补充：

- 第 1→2 步：`analyze` 返回 `id`，客户端 `router.push(/[locale]/s/${id}/confirm)`。
- 第 2 步确认：新增 `POST /api/strategy/:id/confirm`，写 `confirmed_at`。目前"确认"只是内存里的 `confirmed` state，刷新即失效。
- 第 3/4 步：已有 `backtest_runs` / `optimization_runs` 表，按 `strategy_submission_id` 查最近一条即可恢复。
- `/[locale]/s/[id]` 落点逻辑：有 optimization → optimize；有 backtest → backtest；有 confirmed_at → backtest；否则 confirm。

---

## 3. 身份与登录（Google OAuth 2.0 + OIDC）

### 3.1 为什么手写而不用库

运行环境是 Cloudflare Worker（`vinext` + `@cloudflare/vite-plugin`），没有 Node runtime。Authorization Code + PKCE 流程用 WebCrypto 和 `fetch` 就能完整实现，不引入 NextAuth 之类依赖（它们在 Worker 上的适配是额外风险面）。

### 3.2 数据模型

```sql
CREATE TABLE users (
  id             TEXT PRIMARY KEY,        -- uuid
  google_sub     TEXT NOT NULL UNIQUE,    -- Google 稳定用户标识，不用 email 当主键
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
  token_hash TEXT PRIMARY KEY,            -- SHA-256(cookie 里的原始 token)
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id, expires_at);
```

用 `google_sub` 而不是 email 作为唯一身份：Google 允许改邮箱，`sub` 永不变。email 只作展示和联系用。

DB 里存 token 的 SHA-256，cookie 里存原始值。数据库泄漏不等于会话被接管。

### 3.3 登录流程

```
1. 用户点「用 Google 登录」
   → GET /api/auth/google/start?return_to=/zh/s/abc/backtest

2. 服务端：
   - state = 32 字节随机 hex
   - code_verifier = 43~128 字符随机；code_challenge = BASE64URL(SHA256(verifier))
   - Set-Cookie: pt_oauth = {state, verifier, returnTo}，HttpOnly/Secure/SameSite=Lax/Max-Age=600
   - 302 → https://accounts.google.com/o/oauth2/v2/auth
       ?client_id=…&redirect_uri=…&response_type=code
       &scope=openid%20email%20profile&state=…
       &code_challenge=…&code_challenge_method=S256&prompt=select_account

3. Google 回调 GET /api/auth/google/callback?code=…&state=…
   - 比对 query.state 与 cookie 里的 state，不等则 400（CSRF 防护）
   - POST https://oauth2.googleapis.com/token
       code / client_id / client_secret / redirect_uri / grant_type=authorization_code / code_verifier
   - 解出 id_token，校验 iss ∈ {accounts.google.com, https://accounts.google.com}、
     aud === GOOGLE_CLIENT_ID、exp > now
     （token endpoint 响应经 TLS 直连 Google，按 OIDC Core 3.1.3.7 可免签名验签）
   - upsert users（按 google_sub）
   - 建 auth_sessions，Set-Cookie: pt_session=<token>，HttpOnly/Secure/SameSite=Lax/Max-Age=30d
   - 认领匿名记录（见 3.5）
   - 清除 pt_oauth，302 → returnTo（经同源相对路径白名单校验）
```

`return_to` 复用 `chatgpt-auth.ts:57` 里 `safeRelativeReturnPath` 的思路：必须 `/` 开头、非 `//`、解析后同源、不指向认证路径本身。

### 3.4 需要的环境变量

`.dev.vars` 新增（该文件已在 `.gitignore`）：

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

Google Cloud Console 需要登记的 Authorized redirect URI：

- `http://localhost:5173/api/auth/google/callback`（本地 dev，端口以实际 vinext dev 端口为准）
- `https://<生产域名>/api/auth/google/callback`

回调地址由服务端从请求的 `x-forwarded-proto` / `host` 推导，不写死，避免本地和生产分叉。

### 3.5 匿名 → 登录的认领

现在 `sessionId` 在 localStorage，服务端读不到。改为**服务端签发的 HttpOnly cookie `pt_anon`**（首次请求时 `Set-Cookie`），客户端不再自己生成。

登录成功时执行认领：

```sql
UPDATE strategy_submissions SET user_id = ?1
  WHERE session_id = ?2 AND user_id IS NULL;
```

`backtest_runs` / `optimization_runs` 同理。效果：匿名写完策略、看完理解，点登录去回测，之前那条策略自动出现在「我的策略」里，不用重写。

### 3.6 授权模型的收紧

**当前存在的弱点**：`sessionId` 由客户端放在**请求体**里传上来，服务端拿它当授权凭据（`backtest-api.ts:1296`、`1678`、`1842` 等）。任何知道 `strategyId` + `sessionId` 的人都能读取和继续操作该策略。

改造后：

- 服务端从 cookie 解析身份，**请求体里的 `sessionId` 一律忽略**。
- 归属判定统一为 `user_id = ?` OR（`user_id IS NULL` AND `session_id = ?`，`session_id` 取自 `pt_anon` cookie）。
- 第 3、4 步在服务端强制要求 `user_id` 存在，未登录返回 `401 / code: AUTH_REQUIRED`，前端跳登录并带 `return_to`。
- **`optimization_runs` 的确定性 ID（`backtest-api.ts:1722`）目前把 `sessionId` 混进哈希**。改为读取策略行里存的 `session_id`（服务端事实），而不是请求体，保证认领前后 ID 不漂移、历史实验收据仍可复现。

限速也随之分层：匿名按 `pt_anon` 计（更严，只覆盖分析接口），登录用户按 `user_id` 计。

---

## 4. 我的策略

`GET /api/strategy/list`（需登录）一条聚合查询：

```sql
SELECT s.id, s.title, s.asset, s.market, s.status, s.created_at, s.confirmed_at,
       b.net_return, b.max_drawdown, b.trade_count, b.created_at AS last_backtest_at,
       o.id AS optimization_id
FROM strategy_submissions s
LEFT JOIN (最近一条 backtest_runs) b ON b.strategy_submission_id = s.id
LEFT JOIN (最近一条 optimization_runs) o ON o.strategy_submission_id = s.id
WHERE s.user_id = ?
ORDER BY s.created_at DESC
LIMIT 50
```

列表项呈现：标题 · 标的/周期 · 进度徽章（待确认 / 已确认 / 已回测 / 已优化）· 最近回测的净收益与最大回撤 · 时间。操作：继续（跳到当前步骤）、重命名、删除。

空状态直接引导到 `/[locale]/new`，不做空盒子。

需要的 schema 增量：

```sql
ALTER TABLE strategy_submissions ADD COLUMN user_id TEXT;
ALTER TABLE strategy_submissions ADD COLUMN title TEXT;         -- 落库时取 strategyName，用户可改
ALTER TABLE strategy_submissions ADD COLUMN confirmed_at TEXT;
ALTER TABLE strategy_submissions ADD COLUMN archived_at TEXT;
ALTER TABLE backtest_runs        ADD COLUMN user_id TEXT;
ALTER TABLE optimization_runs    ADD COLUMN user_id TEXT;
CREATE INDEX idx_strategy_submissions_user ON strategy_submissions(user_id, created_at DESC);
CREATE INDEX idx_backtest_runs_user        ON backtest_runs(user_id, created_at DESC);
CREATE INDEX idx_optimization_runs_user    ON optimization_runs(user_id, created_at DESC);
```

注意 SQLite 的 `ALTER TABLE ADD COLUMN` **不支持 `IF NOT EXISTS`**。运行时建表走的是 `strategy-api.ts:65` 和 `backtest-api.ts:658` 里的 `ensureSchema`，需要先 `PRAGMA table_info(<表>)` 判断列是否存在再决定是否执行；同时在 `db/schema.ts` 和 `drizzle/` 里补一份对应迁移（下一个 tag 为 `0006_*`）。

---

## 5. 中英文

### 5.1 locale 如何传到 `<html lang>`

`app/layout.tsx` 是 root layout，拿不到 `[locale]` 参数。**不用 middleware**（Next 16 已标记 `middleware.ts` 弃用），改为在 `worker/index.ts` 里做——那里本来就包着 `handler.fetch`：

```ts
// worker/index.ts
const locale = localeFromPathname(url.pathname);           // /zh/... → "zh"
if (!locale) return redirectToLocale(request, url);        // "/" → /zh 或 /en，按 Accept-Language
const localized = new Request(request, {
  headers: new Headers([...request.headers, ["x-prooftrade-locale", locale]]),
});
return handler.fetch(localized, env, ctx);
```

`app/layout.tsx` 用 `headers()` 读 `x-prooftrade-locale` 设 `<html lang>`；页面组件从 `params.locale` 拿。同一个值两条路径来源一致，因为都源自 pathname。

### 5.2 词典

不引 i18n 库，手写类型安全字典：

```
app/i18n/locales.ts        LOCALES = ["zh", "en"]; type Locale
app/i18n/zh.ts             export const zh = { ... } as const
app/i18n/en.ts             export const en: typeof zh = { ... }   ← 缺 key 直接编译报错
app/i18n/index.ts          getMessages(locale)
```

客户端组件（`page.tsx`、`backtest-workspace.tsx` 都是 `"use client"`）从服务端组件接收 `messages` 作为 prop——纯对象可序列化，不需要 context provider。

### 5.3 三块必须一起改的服务端文案

只翻译 UI 是不够的，以下三处会漏出中文：

1. **`app/strategy-language.ts`** — 契约渲染器。`FIELD_LABEL`、`TIMEFRAME_LABEL`、`COMPARISON_LABEL`、`POSITION_LABEL`、`describeRisk` 全是中文字面量，而且 `humanizeExpression` 的中文是**拼接**出来的（`${period} 周期${fieldName}均线`），英文语序不同，不能靠替换词表解决。需要按 locale 分派到两套构句函数。

2. **`worker/strategy-api.ts`** — `detectOutputLanguage(intent)`（`:106`）改为优先用请求里显式传的 `locale`，猜测只作为兜底。模型输出语言跟随 UI 语言而不是输入语言。**`STRATEGY_CACHE_VERSION`（`:10`）必须 bump**——语言语义变了，旧缓存不能复用（`web/AGENTS.md` 的版本门禁要求）。

3. **`worker/backtest-api.ts`** — 报错文案全是中文字面量（如 `:722` 的「日期范围过大」、`:918` 的「当前网页回测数据只包含 OHLCV」）。改为**返回稳定的 `code` + 参数**，由前端按 locale 渲染；未知 code 时回退显示服务端原文。这符合 `AGENTS.md` 里"实现可复用语义原语，而不是绑定具体措辞"的要求。

### 5.4 其余 locale 相关

- `app/layout.tsx` 的 `generateMetadata` 按 locale 出标题、描述、OG 图（现有 `public/og-customer-journey.png` 是中文的，英文需另出一张，或先共用并在文档里记为待办）。
- 数字与日期：`backtest-workspace.tsx:214` 硬编码 `Intl.DateTimeFormat("zh-CN", …)`，改为按 locale。
- 语言切换器放全局 header，切换即 `router.replace` 同路径换前缀，登录用户同时写回 `users.locale`。

---

## 6. 实施顺序

分成五个可独立验证的批次，每批做完都是能跑的状态：

| 批次 | 内容 | 验证方式 |
|---|---|---|
| A | i18n 骨架：worker locale 注入、`[locale]` 路由段、字典、`strategy-language.ts` 双语渲染器 | 现有页面在 `/zh` `/en` 都能正确渲染契约规则 |
| B | 身份：users/auth_sessions 表、Google OAuth 三个端点、cookie 会话、`pt_anon` | 能登录登出，`/api/auth/session` 返回正确身份 |
| C | 所有权：schema 增量、服务端授权改为读 cookie、忽略 body 里的 sessionId、认领逻辑、限速分层 | 匿名建策略→登录→出现在列表；换会话读不到别人的策略 |
| D | 信息架构：落地页与工作台拆分、四个步骤路由、stepper 变导航、`confirm` 端点与状态恢复 | 每步刷新不丢进度，链接可定位 |
| E | 我的策略页、账号页、语言切换器、API 错误码双语 | 列表/重命名/删除/继续可用 |

依赖关系：A 独立；B 独立；C 依赖 B；D 依赖 C（第 3 步要拦登录）；E 依赖 C+D。A 和 B 可并行。

### 门禁提醒

按 `web/AGENTS.md`：语义变更要 bump 对应版本（本次涉及 `STRATEGY_CACHE_VERSION`）；不能只让某一层支持而其他层不支持（locale 必须贯穿契约渲染、模型输出、错误文案、缓存键）；`tests/rendered-html.test.mjs` 依赖首页 HTML 输出，路由改造后必须同步更新。

---

## 7. 本设计不包含

- 分享链接、订阅计费、异步回测队列（仍在 [项目状态](PROJECT_STATUS.zh-CN.md) 的未完成项里）。
- 邮箱/密码登录、钱包绑定（`PRODUCT_SPEC.md` 5.1 的 MVP 项，本次只做 Google）。
- 策略重命名以外的编辑；策略版本树 UI。
- 英文 OG 图与英文示例策略语料。


---

## 8. 实现与设计的偏差

落地时改动了三处，都是环境约束造成的：

1. **locale 不用 middleware，也不用 `[locale]` 根布局。** Worker 从 pathname 解析 locale 后注入 `x-prooftrade-locale`，`app/layout.tsx` 读这个头设 `<html lang>`，页面组件读 `params.locale`。同时 `app/[locale]/layout.tsx` 不能声明 `generateStaticParams`——它与 `dynamic = "force-dynamic"` 冲突，会让整棵树渲染失败。

2. **词典不跨服务端/客户端边界传递。** 词条里含格式化函数，函数不可序列化，作为 prop 传给客户端组件会让 RSC 渲染直接报错。客户端组件改为只接收 `locale` 字符串，自己调 `getMessages(locale)`；两份词典因此进入客户端 bundle。

3. **第 3、4 步共用一个组件，用 `step` prop 分派。** 两步共享回测配置、参数草稿和实验状态，拆成两个组件需要把这些状态提升到一个新的容器里。改为一个组件按 `step` 渲染对应半边；第 4 步从 `backtest_runs` 的收据水合，不要求客户重新配置区间和费用。

另外补了一处设计里没写的服务端约束：第 3 步要求 `confirmed_at` 存在，参数版本策略在创建时直接带上 `confirmed_at`（它的语义由实验锁定，不需要再让模型读一遍）。
