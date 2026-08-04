# Backtest Service 改造方案（Path A：单一引擎）

状态：Draft v0.1
决定：以 CLI 沙箱引擎为唯一语义权威，Web 不再解释机器契约，改为调用独立 Node 执行服务。

## 1. 目标

- **单一引擎**：真实 TypeScript 策略程序（AST 校验 + 完整类型检查 + QuickJS 沙箱执行）是所有回测/优化的唯一执行器；机器契约只做审计记录，不再作为执行真相。
- **消除双引擎分叉**：删掉 Web 的 `IndicatorEngine` / `runContractBacktest` / 正则条件解释器。
- **执行与服务分离**：Web（Cloudflare Worker）保持 serverless 前端 + 控制面；执行层放进独立 Node 服务，可独立扩缩、承担长任务。
- **语义准入门禁**：`ready` 策略必须在 analyze 阶段就通过「程序 ↔ 契约」反向核对 + 行为场景验证，杜绝"用户确认的契约和实际执行的程序不一致"。

## 2. 边界

服务**做**：
- `POST /v1/strategy/verify`：编译 + 类型检查 + `verifyStrategySemantics`（反向抽取 + 契约逐条比对 + 正反场景）。
- `POST /v1/backtest`：执行程序回测，返回统一结果与统一指标。
- `POST /v1/optimization/run|blind|adopt`：参数发现 + 候选实验 + 稳健性门禁 + 一次性盲测。
- （中期）`POST /v1/dataset/...`：数据所有权（Parquet 分区 + catalog 加载）。

服务**不做**：LLM 生成、用户/计费/权限（控制面）、交易执行、Web 页面。

## 3. 复用与零移植

服务与根包同仓库，直接 import 现有 `src/` 模块，**无需移植引擎**：

| 能力 | 来源 |
|---|---|
| AST 安全 + TS 类型检查 + 转译 + hash | `src/compiler/` |
| QuickJS 沙箱 | `src/runtime/sandbox.ts` |
| 回测循环 | `src/runtime/backtest.ts` |
| 指标 | `src/runtime/backtest-metrics.ts` |
| 契约反向抽取 + 行为场景 | `src/semantics/` |
| 多周期聚合 | `src/data/aggregate-bars.ts` |
| 策略生成/修复/版本 | `src/studio/strategy-studio.ts` |
| 参数发现 + 稳健性门禁 + 盲测 | 从 `web/worker/backtest-api.ts` 移植为 `src/optimization/`（见 §7） |

服务框架：Fastify（对齐 `TECH_ARCHITECTURE.md` §8.1 选型），开发用 `tsx`，Node ≥22，ESM。

## 4. 共享契约

在 `src/contracts/`（或 `packages/contracts/`）定义 JSON Schema + 类型，Web 与服务两端共用：

- `VerifyArtifactRequest / Response`
- `BacktestRequest`（`source` + `contract` + `bars` 或 `datasetRef` + `config`）/ `BacktestResponse`（统一 metrics + trades + equity + series）
- `OptimizationRequest / Response`（含 robustness、blind 状态、参数版本）
- `ErrorEnvelope`（稳定 `code` + `params`，沿用 Web 现有错误码约定）

## 5. 数据传递（决策点）

- **短期**：Web 现有分层 K 线管线保留，`bars` 放请求体传给服务；服务纯计算。改动最小，先解锁单一引擎。
- **中期**：数据所有权移入服务（R2/对象存储存 Parquet 分区 + catalog），Web 只传 `datasetRef` + 窗口。回测 manifest 必须含数据集摘要。
- 无论哪个阶段，回测请求都必须带 `sourceHash` + `barsDigest`，服务端幂等、可复现。

## 6. 迁移步骤（每阶段可独立合并上线）

### Phase 0 — 基线锁定（已交付 2026-08-04）
- **单引擎黄金基线** `test/engine-golden.test.ts`：6 个维度、7 个用例，全部钉死在 CLI 沙箱上——阈值/状态、20/50 EMA 趋势、负 Funding 门禁（含 Funding PnL）、Open Interest 门禁、多周期（15m 主周期 + 已闭合 1h RSI）、同 Bar 止盈止损冲突（止损优先确定性）+ 可复现性/权益曲线不变量。这是迁移的回归基线：Phase 3/4 改动引擎后必须保持这些结果不变。
- **跨引擎实时分叉**：不在单元测试层面做。已核实根包与 `web/` 是两套隔离包环境（Web 引擎依赖 `fflate` + Cloudflare 类型，根 `tsc` 无法 import；CLI 沙箱依赖 `quickjs-emscripten`，Web 包没有），单元级跨 import 不可行。实时分叉量化推迟到 **Phase 1 shadow 模式**（两个引擎同场运行对比），这本身就是"执行必须收敛进单服务"的又一证据。
- 基线正确性锚点：CLI 引擎已通过 Python 参考引擎逐交易逐权益点交叉验证（0 差异），黄金值可信。

### Phase 1 — 服务骨架 + 回测代理（已交付 2026-08-04）
- [x] 建 `services/backtest/`，Fastify 暴露 `POST /v1/backtest`：`compileStrategySource` → `runBacktest` → `calculateBacktestMetrics`；`POST /v1/strategy/verify`（Phase 2）。
- [x] 共享契约 `src/contracts/`（`backtest-1.0` / `verify-1.0` / `error-1.0`），服务与 Web 走同一 wire 格式。
- [x] 引擎补齐 `equityPercent` 仓位：core types / sandbox / backtest / SDK 声明 / 语义抽取，单引擎覆盖 Web 契约的全部 sizeKind。
- [x] Web `/api/backtest/run` 在 `BACKTEST_SERVICE_URL` 设置时代理到服务执行真实程序；未设置时回落旧解释器（feature-flag）。
- [x] **shadow 模式**：`BACKTEST_SHADOW_MODE="true"` 时同跑旧解释器，按 tradeCount/finalEquity/netReturn 阈值比较并告警，不回滚 UI。
- [x] 缓存键加入 `engine` 并升版 `backtest-v5-engine-service`，避免新旧引擎结果串键。
- [x] 代理路径保留 `assertServiceSupported` 源码级安全网：Web K 线缺 funding/OI/mark/turnover 数据时按历史 `OHLCV_ONLY` 拒绝，防止静默用 0 计算。
- 部署：本地 `npm run backtest:service`；生产 Cloud Run / Fargate。Web→服务认证（共享 secret / mTLS + 请求签名）仍待做。
- 前端字段映射：`metrics.buyAndHoldReturn` 由 Web 从 bars 本地补算；其余 metrics/trades/equityCurve 直接透传。

### Phase 2 — 语义准入门禁（已交付 2026-08-04）
- [x] 服务 `POST /v1/strategy/verify`：编译 + 类型检查 + `verifyStrategySemantics`（反向抽取 + 契约逐条比对 + 正反场景）+ 能力扫描。
- [x] Web analyze 对 `ready` 制品在落库前调用 verify，通过才持久化为可运行；编译/语义不一致返回 `STRATEGY_VERIFY_FAILED`，不再落库。
- [x] 能力拦截：`availableCapabilities`（Web 默认 OHLCV+indicators+multiTimeframe+state+arithmetic）之外的 funding/OI/mark/turnover 在 analyze 阶段降级为 `unsupported` 并披露能力缺口，不再 backtest 时抛 `OHLCV_ONLY` 500。
- [x] `enforceEntryConditionFloor` 保留（补充性，不是主门禁）。
- [x] 服务不可达时 analyze 直接返回 `STRATEGY_VERIFY_UNAVAILABLE`（503 + `Retry-After: 30`），不再回落 substring `structuralChecks` 落库。原先的降级会把没验过的程序存成 `ready`：模型一旦生成另一套方言（缺 `id`/`version`、用 `openLong()` 而非 `onBar` 返回 decision），用户能确认但每次回测都 `COMPILE_FAILED`。服务是唯一执行引擎，没验过的程序之后也无法变成可运行的，所以停机必须在这里暴露。`structuralChecks` 仅保留给门禁不适用的情形（非 `ready` 状态，或未配置服务）。
- [x] Web analyze 提示词内联 `STRATEGY_SDK_DECLARATION`（与 CLI 侧 `src/studio/prompt.ts` 同源），并给出程序形状硬性要求与最小可编译范例；`STRATEGY_CACHE_VERSION` 随之升到 `strategy-intent-v6-sdk-declaration`，旧提示词下缓存的制品不再被复用。
- [x] `scripts/audit-strategy-sources.ts` 审计历史落库制品：编译每条 `ready` 源码，报告无法运行的行，`--apply` 归档它们。

### Phase 3 — 优化迁移（已交付 2026-08-04）
- [x] `src/optimization/`：参数发现/应用（`parameter-discovery.ts`，契约 canonical、id 与 Web 完全一致）、候选生成、试次评估、walk-forward / 敏感性 / 成本压力 / 市场状态 / 多次选择惩罚门禁（`optimization.ts`）、一次性盲测纯计算（`blind-test.ts`）。
- [x] **执行切换为真实程序**：引擎 `runBacktest` 新增 `evaluationStartTime`（绩效窗口分离：窗口前历史喂指标 warm-up，窗口前不交易/不记权益），golden 测试钉死。
- [x] **参数应用到程序**：`program-apply.ts` 按 canonical rule/condition 匹配把契约相对参数定位到程序 AST 的数值字面量并改写源码（覆盖 hoisted 指标变量、decision 字段、threshold），基线与候选都是同一程序家族，只差被调的数值；`applyParametersToSource` 经 golden 策略验证。
- [x] 服务 `POST /v1/optimization/run` / `/v1/optimization/blind` / `/v1/optimization/materialize`；Web `optimization/run|blind` 代理到服务，`adopt` 仍在 Web。
- [x] **参数版源码物化**：adopt 经服务 `/v1/optimization/materialize` 生成真实程序源码（`programStatus: program-derived`），解决此前"空白源码"缺口。
- [x] D1 仍是盲测状态机持有方：`blind_status` reserved→running→passed/failed 原子领取与落库留在 Web；服务只做纯计算并返回收据。
- [x] 缓存键加入 `engine`+`sourceHash` 并升版 `optimization-v4-engine-service`；experiment id 派生自新 key，避免新旧引擎盲测串号。
- 性能说明：试次全部在服务端跑真实沙箱，12 试次约 30–50 次内层回测，量级秒到十秒级；异步任务队列留到 Phase 4。

### Phase 4 — 性能与异步（3–5 天）
- 指标序列在试次循环外只算一次（现 Web 每次试次重建 `IndicatorEngine`，50 次全量重算）。
- 沙箱内单次 eval 跑完整循环，替代每 bar `evalCode`（README 已提的"持久 Runtime 下一次 eval"方向），把 10k bar 单次回测从 ~2s 压进几十 ms。
- 引入异步任务队列（Cloudflare Queues 或服务内 job store + 轮询）：长回测/优化返回 `jobId`，Web 轮询。文档已列此缺口，此处补上。

### Phase 5 — 数据所有权合并 + 清理（2–4 天）
- 数据管线（`src/data`）进服务：对象存储存 Parquet + catalog；服务按 `datasetRef` 加载，回测 manifest 含数据集摘要。
- 删除 Web 引擎：`IndicatorEngine`、`runContractBacktest`、正则解析、`compact`/`numberTokens` 等全部移除，只留薄代理。
- Web 引擎测试改为对服务 API 的契约测试；Web `backtest-api.ts` 从 2202 行瘦身到几百行。

## 7. 需要新建/移植的模块

- `src/optimization/parameter-discovery.ts`：从契约（或程序语义）发现可调数字参数；沿用 Web 的 `numberTokens`/`callArgumentContext`/`isLagArgument` 思路，但语义骨架改用 `src/semantics/contract.ts` 的 canonical 归一。
- `src/optimization/robustness.ts`：walk-forward / 敏感性 / 成本压力 / 市场状态。
- `src/optimization/blind-test.ts`：一次性盲测纯计算，返回可审计收据。
- `src/backtest-service/`：Fastify 路由 + 认证中间件 + 错误映射。
- `src/contracts/`：共享 schema + 类型 + 版本号。

## 8. 风险与回滚

- **迁移期**：shadow 双跑对比，差异 > 阈值告警；差异归零后切流。
- **幂等**：请求带 `sourceHash` + `barsDigest`；服务无状态，重复请求返回同一结果。
- **认证**：Web→服务共享 secret + 请求签名（或 mTLS）；服务不暴露公网。
- **WASM**：quickjs-emscripten 在 Node 服务无兼容问题（本就 Node 运行）。
- **盲测一次性**：状态机（`blind_status` 原子领取）留在 D1，服务纯计算，不破坏"只执行一次"。

## 9. 里程碑顺序

Phase 0 → 1 → 2 → 3 → 4，逐阶段合并；Phase 5 可与 Phase 3 并行。
