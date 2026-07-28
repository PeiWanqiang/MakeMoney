# 项目状态与后续工作

最后更新：2026-07-29  
当前阶段：Phase 0 研究原型  
状态口径：只有“代码存在、自动测试通过、真实数据或端到端样例验证”才记为已实现；只有文档方案的不记为产品已完成。

## 1. 当前结论

项目已经从概念设计进入可运行的研究原型：受约束 TypeScript 策略可以被检查、编译、哈希并在 QuickJS/WASM 沙箱执行；Bar 级回测可以加载真实的 1m Parquet 数据；本地已经验证一整年 BTC 1m 数据。

项目尚未成为可供用户使用的产品。自然语言生成、Web 产品、完整永续历史数据、Paper Runtime、独立风控、实盘执行、计费和商务验证均未完成。

## 2. 已完成并验证

### 2.1 产品、技术与商务设计

- [x] 产品定位、目标用户、功能地图、阶段门禁和产品假设已形成文档。
- [x] Code-first 策略方向已确定：AI 生成受约束 TypeScript，DSL 只作为内部 IR/审计摘要。
- [x] 控制平面、数据平面和交易平面的目标架构及技术选型已形成文档。
- [x] 商业阶段已确定：先做 Research/Paper SaaS，再考虑受控实盘和策略网络。
- [x] 订阅价格假设、GTM、合规门禁、运营指标和 90 天验证计划已形成文档。

说明：以上是设计产物，不代表用户访谈、支付预审、法律意见或商业转化已经完成。

### 2.2 策略程序原型

- [x] 单一 `defineStrategy({...})` 程序入口。
- [x] AST 静态检查：拒绝 import、网络、进程、动态代码、非确定时钟、循环和危险属性等能力。
- [x] TypeScript 转译、规范化 JavaScript 和 SHA-256 程序哈希。
- [x] QuickJS/WASM 隔离执行，包含时间与内存限制。
- [x] Strategy SDK 上下文：OHLCV、Funding、OI、账户、仓位和持久状态。
- [x] 指标：SMA、EMA、Highest、Lowest、Percent Change、Cross Above/Below。
- [x] 决策：Hold、Open、Close，以及运行时输出校验。
- [x] 黄金示例策略和端到端 demo。

实现位置：

- `src/compiler/`
- `src/runtime/sandbox.ts`
- `src/strategy-sdk.ts`
- `examples/strategies.ts`

### 2.3 Bar 级回测原型

- [x] 已闭合 Bar 生成信号、下一根 Bar 开盘成交。
- [x] Long/Short、固定名义仓位和按止损风险计算仓位。
- [x] Taker fee、固定 bps 滑点和最大杠杆限制。
- [x] 止损、风险收益比止盈、Funding 和期末平仓。
- [x] 同一 Bar 同时触发止盈止损时，确定性地按止损先发生处理。
- [x] 交易记录、权益曲线和策略状态输出。

实现位置：`src/runtime/backtest.ts`。

### 2.4 1m 历史数据基础设施

- [x] 原始数据统一为 1m；15m、1h、4h 从 1m 确定性聚合。
- [x] Hyperliquid 近期 1m Candle/Funding 下载客户端。
- [x] Binance Vision 月包下载、官方 SHA-256 校验和断点续传。
- [x] Kraken 完整 OHLCVT ZIP 的流式导入器。
- [x] 按月 Parquet 分区、分区 manifest、数据 SHA-256 和全局 catalog。
- [x] 毫秒/微秒/秒时间戳标准化。
- [x] 重复、非法 OHLC、数据缺口检查。
- [x] 已校验分区重跑时跳过，不完整聚合桶不进入回测。

实现位置：

- `src/data/`
- `scripts/download-binance-history.ts`
- `scripts/import-kraken-history.ts`
- `scripts/download-hyperliquid.ts`

### 2.5 已完成的真实数据验证

本地已经下载并验证 Binance Spot `BTCUSDT` 2024 全年：

| 项目 | 验证结果 |
|---|---:|
| 1m 行数 | 527,040 |
| 理论分钟数 | 527,040 |
| 缺失分钟 | 0 |
| Parquet 月分区 | 12 |
| 完整 1h Bar | 8,784 |
| 不完整 1h 桶 | 0 |
| ZIP 缓存 | 约 31 MB |
| Parquet + manifest | 约 19 MB |

数据目录：`data/history/binance-spot/BTCUSDT/1m/`。该目录已被 Git 忽略，只存在于本机。

真实数据已接入回测：2024 全年 1m 数据聚合为 2,196 根 4h Bar 后完成策略执行。示例策略依赖负 Funding，而该数据集是现货、Funding 为 0，因此产生 0 笔交易。这个结果只证明数据到回测的链路可运行，不证明策略有效。

### 2.6 工程验证

- [x] `npm test`：4 个测试文件、13 项测试全部通过。
- [x] `npm run typecheck`：通过。
- [x] 数据 parser、时间戳标准化、完整桶聚合和 Parquet/catalog 往返校验已有自动测试。
- [x] 本地 2024 年数据重复执行时，12 个分区均通过哈希校验并被正确跳过。

## 3. 已实现但尚未完成验证

### 3.1 Kraken 十年 BTC 1m

- [x] 导入器代码已完成，可流式读取 `XBTUSD_1.csv` 并按月写 Parquet。
- [ ] Kraken 完整 ZIP 尚未在本机下载。
- [ ] 2016-01-01 至 2026-01-01 的十年数据尚未实际导入和核对总行数、缺失分钟、首尾价格及异常点。
- [ ] Kraken 季度增量更新的自动合并与修订版本管理尚未实现。

注意：Google Drive 可能阻止自动下载；代码支持手动下载官方 ZIP 后使用 `--archive` 导入。

### 3.2 Hyperliquid 近期数据

- [x] 近期 1m Candle 和 Funding 客户端、快照写入代码已完成。
- [ ] 尚未保存一份固定的 Hyperliquid BTC 快照作为仓库外测试基准。
- [ ] 尚未为 Hyperliquid 客户端加入 mock 和真实接口集成测试。
- [ ] 普通 Candle API 仅覆盖最近约 5,000 根 1m Bar，不能承担十年历史数据。

### 3.3 真实回测

- [x] 目录 catalog 可以被加载、校验、聚合并送入回测。
- [ ] 尚未使用与数据字段匹配的策略完成一次有实际开平仓的年度回测。
- [ ] 尚未用独立实现交叉验证收益、手续费、Funding、止盈止损结果。
- [ ] 尚未生成完整的回测 manifest、统计指标和可视化报告。

## 4. 规划中未完成

### P0：完成研究原型退出条件

这些工作完成前，不进入 Web MVP：

1. **长期永续数据集**
   - 接入至少一个长期可用的 BTC 永续数据源。
   - 同步 K 线、Funding、Mark Price；评估 Open Interest 的可用历史范围。
   - 明确现货代理数据与永续成交数据的用途，禁止静默替换。
   - 生成可固定版本和复现的多年月度数据集。

2. **有意义的真实策略基线**
   - 先增加不依赖 Funding 的趋势/突破策略，在 2024 现货数据上完成有成交的回测。
   - 再用永续数据验证 Funding 策略。
   - 输出 Net return、最大回撤、Sharpe、交易次数、胜率、费用、Funding 和滑点分项。

3. **回测性能与正确性**
   - 复用持久 QuickJS Runtime，避免每根 Bar 重建沙箱。
   - 使用增量指标状态，避免每次复制全部历史 `bars.slice(...)` 和重复计算 EMA。
   - 增加保证金、爆仓、Maker/Taker、缺口政策和更真实滑点模型。
   - 建立另一个参考实现进行结果交叉验证。

4. **策略编译器完整性**
   - 使用 Strategy SDK 声明执行完整 TypeScript 类型检查；当前 `transpileModule` 不能替代完整语义类型检查。
   - 抽取数据依赖、warm-up、状态键、动作和能力等级。
   - 为状态大小、输出大小和指标参数增加限制。

5. **黄金策略与测试集**
   - 从当前示例扩展到至少 20 条黄金策略。
   - 覆盖趋势、突破、均值回归、Funding、Long/Short、状态策略和边界案例。
   - 为每条策略固定数据、程序哈希和预期结果。

6. **AI 生成闭环**
   - 接入 LLM provider adapter。
   - 实现自然语言意图 → 候选程序 → 结构化编译错误 → 定点修复。
   - 增加程序反向解释、语义 diff 和用户确认。
   - 建立至少 100 条真实用户意图评测集。

7. **Paper Runtime 一致性**
   - 实现事件录制与 Replay。
   - 用同一录制数据验证 Backtest 与 Paper 信号一致。
   - 实现状态持久化、心跳、断线补放、暂停和恢复。

Phase 0 原定退出条件保持不变：20 条预设策略能够稳定编译，并在固定数据上复现结果。

### P1：封闭 MVP

- [ ] Web 产品：登录、对话策略编辑器、代码/解释视图、回测报告和数据图表。
- [ ] Control API、PostgreSQL 数据模型、对象所有权与幂等接口。
- [ ] 回测任务队列、配额、取消、重试和制品管理。
- [ ] 策略不可变版本、比较、回滚和 Fork。
- [ ] 实时 Paper 部署、虚拟账户与监控通知。
- [ ] 分享页、基础订阅和使用量计费。
- [ ] 30～50 名设计合作用户闭环。

### P2：受控实盘

- [ ] Hyperliquid API/Agent Wallet 授权。
- [ ] 独立 Risk Engine、Execution Service 和签名边界。
- [ ] client order ID、订单/成交/仓位对账和断线恢复。
- [ ] 最大仓位、杠杆、日亏损、回撤、数据新鲜度和只减仓规则。
- [ ] Dead Man's Switch、Kill Switch、安全审计和 P0 值班。
- [ ] Builder Fee 授权、费用披露和撤销。
- [ ] 目标国家法律意见、地区 allowlist、条款和风险披露。

### P3：策略网络

- [ ] 公开且不可选择性删除的验证记录。
- [ ] 策略 Fork、关注、创作者主页和订阅。
- [ ] Creator Agreement、内容审核、利益关系披露、分成、税务和退款系统。

## 5. 商务执行尚未开始

商务方案已经写完，但以下事项没有执行完成：

- [ ] 访谈 30 名目标交易者。
- [ ] 收集至少 100 条真实自然语言策略；语言覆盖最终目标为 500 条。
- [ ] 测试定位页面、价格区间和付费意愿。
- [ ] 招募 30～50 名设计合作用户。
- [ ] 初选 5～8 个候选国家并取得专业法律分析。
- [ ] 与至少 3 家支付/Merchant of Record 机构完成业务预审。
- [ ] Terms、Privacy、Risk、Refund 等政策文件。
- [ ] 品牌名、域名和商标筛查。
- [ ] 用户支持、数据质量、安全和事故响应责任人。

开始收费、扩大获客、实盘和创作者商业化仍分别受 [BUSINESS_PLAN.md](BUSINESS_PLAN.md) 中 Gate A～D 约束。

## 6. 已确定且不应反复讨论的决策

1. 首发方向是国际加密策略研究平台，目标用户是能描述交易规则的永续交易者。
2. AI 负责生成程序，不直接下单；确定性 Runtime 和独立 Risk Engine 才是可信边界。
3. 用户策略使用受约束 TypeScript，不再尝试用大型 JSON DSL 包住所有意图。
4. 原始 K 线统一为 1m，其他周期确定性聚合。
5. 历史文件使用不可变 Parquet、SHA-256、分区 manifest 和 dataset catalog。
6. Kraken `XBTUSD` 作为十年单一现货市场候选；Binance `BTCUSDT` 作为快速验证源；不同 venue/instrument 不自动拼接。
7. 首发交易执行场所仍计划为 Hyperliquid，首批标的是 BTC、ETH、SOL 永续。
8. 先销售 Research/Paper 订阅；实盘、成交收费和策略市场必须晚于法律、安全和运营门禁。
9. 平台不托管资金，不索取助记词或主钱包私钥，不提供提现或转账能力。

## 7. 建议的紧接下一步

下一工作单元建议限定为：

> 在现有 2024 BTCUSDT 1m 数据上增加一个不依赖 Funding 的 EMA/突破基线，优化回测热路径，跑出第一份包含交易、费用、滑点、权益曲线和核心指标的可复现年度报告。

这个工作能同时验证数据、策略程序、回测正确性和性能；完成后再投入长期永续数据与 LLM 生成，风险最低、反馈最快。

## 8. 常用验证命令

```bash
npm test
npm run typecheck

npm run data:binance-history -- \
  --symbol BTCUSDT \
  --start 2024-01-01T00:00:00Z \
  --end 2025-01-01T00:00:00Z

npm run backtest:real -- \
  data/history/binance-spot/BTCUSDT/1m/dataset.catalog.json 4h

npm run data:kraken-history -- \
  --pair XBTUSD \
  --start 2016-01-01T00:00:00Z \
  --end 2026-01-01T00:00:00Z
```

## 9. 仓库状态提醒

本次会话新增和修改的代码、文档及依赖目前仍在工作区中，尚未创建 Git commit。`data/cache/`、`data/history/` 和 `data/snapshots/` 已被忽略；本地下载数据不会随代码提交或自动出现在其他环境。
