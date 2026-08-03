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

### Phase 0 — 基线锁定（1–2 天）
- 起草**跨引擎黄金测试**：同一 bars + 同一策略（覆盖 funding / OI / 多周期 / 同 Bar 止盈止损冲突 / 边界），CLI 沙箱 vs Web 解释器，逐交易、逐权益点 diff。
- 目的：把现有分叉量化成数字，作为迁移的回归基准；Phase 3 之后该测试改为对服务 API 的契约测试。

### Phase 1 — 服务骨架 + 回测代理（2–4 天）
- 建 `services/backtest/`，暴露 `POST /v1/backtest`：`compileStrategySource` → `runBacktest` → `calculateBacktestMetrics`。
- Web `/api/backtest/run` 改为代理到服务；**shadow 模式**：同时跑旧解释器，差异超阈值告警，不回滚 UI。feature-flag 切换。
- 统一结果 schema，Web 前端字段映射适配。
- 部署：本地 `npm run backtest:service`；生产 Cloud Run / Fargate。Web→服务认证：共享 secret / mTLS + 请求签名。

### Phase 2 — 语义准入门禁（2–3 天）
- 服务加 `POST /v1/strategy/verify`，Web analyze 在 `ready` 前调用，通过才落库（替换现有 substring 扫描 `structuralChecks`）。
- 效果：契约与程序强制一致；funding/OI 等能力在 analyze 阶段就被能力声明拦截，不再 backtest 时抛 `OHLCV_ONLY` 500。
- `enforceEntryConditionFloor` 保留（补充性，不是主门禁）。

### Phase 3 — 优化迁移（3–5 天）
- 把 `extractParameterSchema` / `applyParameters` / `walkForwardEvidence` / `sensitivityEvidence` / `costStressEvidence` / `regimeEvidence` / 盲测从 `web/worker/backtest-api.ts` 移植为 `src/optimization/`，执行从 `runContractBacktest` 换成 `runBacktest`（真实程序）。
- Web 端 `optimization/run|blind|adopt` 代理到服务。D1 仍是状态机持有方：服务只做纯计算并返回收据，Web 负责 `blind_status` 原子领取与落库。

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
