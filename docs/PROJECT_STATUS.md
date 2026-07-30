# 项目状态与后续工作

最后更新：2026-07-30
当前阶段：Phase 0 本地产品纵切原型
状态口径：只有“代码存在、自动测试通过、真实数据或端到端样例验证”才记为已实现；只有文档方案的不记为产品已完成。

## 1. 当前结论

项目已经从量化研究原型转回产品主路径：受约束 TypeScript 策略可以被完整类型检查、哈希并在 QuickJS/WASM 沙箱执行；自然语言策略 provider、机器可校验的语义契约、反向语义抽取、行为场景、变异测试、不可变版本和可选真实数据回测已经形成一个本地 CLI 纵切。

项目尚未成为可供用户使用的产品。DeepSeek provider 已完成真实生成、对话修改和全历史回测验收；OpenAI provider 只有 mock 验证。Web 产品、Paper Runtime、独立风控、实盘执行、计费和商务验证均未完成。

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
- [x] 单次回测复用持久 QuickJS Runtime，程序只加载一次。
- [x] EMA 使用沙箱内增量缓存，避免每根 Bar 从头计算全部历史。
- [x] Strategy SDK 上下文：OHLCV、Funding、OI、账户、仓位、持久状态和受限历史窗口。
- [x] 指标：SMA、EMA、Highest、Lowest、Percent Change、Standard Deviation、RSI、ATR、MACD、Bollinger Bands、Cross Above/Below。
- [x] 多周期读取：1m、15m、1h、4h；只向策略暴露在当前主周期时刻已经闭合的高周期 Bar，避免未来数据泄漏。
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
- [x] Slippage cost 独立记录。
- [x] Net return、CAGR、最大回撤、Sharpe、Sortino、Profit factor、Expectancy、胜率、Exposure、费用、Funding 和滑点指标。
- [x] 报告 ID 固定绑定引擎版本、策略哈希、数据分区哈希、周期和回测配置。

实现位置：`src/runtime/backtest.ts`。

### 2.4 1m 历史数据基础设施

- [x] 原始数据统一为 1m；15m、1h、4h 从 1m 确定性聚合。
- [x] Hyperliquid 近期 1m Candle/Funding 下载客户端。
- [x] Binance Vision 月包下载、官方 SHA-256 校验和断点续传。
- [x] Kraken 完整 OHLCVT ZIP 的流式导入器。
- [x] Binance USD-M 永续成交 K 线、Mark Price 和 Funding 三源月度对齐下载器。
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

真实数据已接入回测：2024 全年 1m 数据聚合为 2,196 根 4h Bar，运行不依赖 Funding 的 20/50 EMA Long-only 工程基线。

| 指标 | 结果 |
|---|---:|
| 初始资金 | 10,000 |
| 期末权益 | 11,454.89 |
| Net return | 14.55% |
| 最大回撤 | -7.65% |
| Sharpe | 1.66 |
| Profit factor | 2.62 |
| 交易数 | 19 |
| 胜率 | 31.58% |
| Fees | 37.53 |
| Slippage cost | 16.68 |
| 回测热路径耗时 | 约 0.46～0.48 秒 |

此前同样 2,196 根 Bar 的示例执行约需 21 秒；持久沙箱和增量 EMA 将其缩短约 44 倍。报告 ID 为 `b70ee9ec...b68c2`，相同输入两次生成的报告文件 SHA-256 均为 `fab7bbc6...f6012`。

以上是单年度、单市场、样本内工程基线，没有样本外验证，不构成策略有效性或未来收益证据。

#### 2020～2026 BTCUSDT 永续

已完成 Binance USD-M `BTCUSDT-PERP` 2020-01-01 至 2026-06-30：

| 项目 | 结果 |
|---|---:|
| 1m 成交 K 线 | 3,417,120 |
| 理论分钟数 | 3,417,120 |
| 成交缺失/重复/非法 | 0 / 0 / 0 |
| Funding 事件 | 7,119 |
| 月分区 | 78 |
| Mark Price 缺失 | 13,015（约 0.38%） |
| 完整 4h Bar | 14,238 |
| ZIP 缓存 / Parquet | 约 232 MB / 140 MB |

Mark 缺失分钟使用成交收盘价回退，并在分区质量信息和 catalog 中披露。数据结束于最后一个完整 UTC 月；当前月实时尾部尚未合并。

两条工程基线已运行：

| 策略 | 交易数 | Net return | CAGR | 最大回撤 | Sharpe | Profit factor |
|---|---:|---:|---:|---:|---:|---:|
| EMA + negative Funding | 82 | -16.29% | -2.70% | -17.12% | -0.75 | 0.53 |
| Long-only 20/50 EMA | 135 | 32.15% | 4.38% | -20.45% | 0.54 | 1.38 |

Funding 策略的负结果是有效验证结果，不应为得到正收益而修改逻辑。两者均未进行样本外、参数敏感性或独立引擎验证，不构成策略有效性或未来收益证据。

### 2.6 工程与策略语义验证

- [x] `npm test`：15 个测试文件、56 项测试全部通过。
- [x] `npm run typecheck`：通过。
- [x] 数据 parser、时间戳标准化、完整桶聚合和 Parquet/catalog 往返校验已有自动测试。
- [x] 本地 2024 年数据重复执行时，12 个分区均通过哈希校验并被正确跳过。
- [x] 20 条语义黄金策略，覆盖趋势、突破、均值回归、Funding、Long/Short、RSI、ATR、MACD、Bollinger Bands 和多周期。
- [x] 100 条中英文/口语化/严格表达映射到 20 条黄金意图；这是合成评测集，不冒充真实用户语料。
- [x] 生成程序反向抽取规则并与模型输出的机器契约逐条比较。
- [x] 从契约自动生成正例和逐条件反例；123/123 个行为场景通过。
- [x] 自动注入周期、交叉方向、Long/Short、仓位、止损和平仓错误；100/100 个变异程序被拒绝。
- [x] `npm run semantics:golden` 可独立复跑上述语义与变异门禁。
- [x] `npm run semantics:deepseek` 可对 100 条合成表达运行真实模型评测，支持并发、筛选、断点续跑、内容指纹、原子报告、token/延迟/成本统计和不重新调用模型的语义重算。
- [x] DeepSeek V4 Pro 首轮 100 条基线通过 86 条：9 条契约错配、5 条生成错误、0 条 provider 错误；P50/P95 延迟约 35.7/126.1 秒，总计 637,593 tokens，按评测时官方价格估算 $0.3382。
- [x] V3 全量评测通过 94/100：5 条契约错配、1 条生成错误、0 条 provider 错误；22 次自动修复，P50/P95 延迟约 37.9/100.5 秒，总计 581,118 tokens，估算 $0.2889。
- [x] V3 失败归因定位到 percentChange 百分比单位说明、契约指标前缀、Donchian OHLC 字段和 level/crossing 语料歧义；修复后 V4 定向回归 6/6 通过。
- [x] V4 全量评测通过 100/100：0 条契约错配、0 条生成错误、0 条 provider 错误；21 次自动修复，P50/P95/最大延迟约 34.4/84.7/248.1 秒，总计 587,528 tokens，估算 $0.2839。
- [x] 互联网真实表达采集 v0.1：Stack Exchange 官方 API、GitHub 许可证白名单、HTML/Markdown 清洗、来源哈希、相关性评分、精确/近似去重、原子 JSONL 和 checkpoint 已实现。
- [x] 首批真实 API 采集已验证：Stack Exchange 保存493条、GitHub保存10条许可记录；过滤后得到495条机器候选，其中472条高相关、23条可能相关，重复运行命中 checkpoint。
- [x] 可审计人工标注链路：独立审核、裁决、原文字符证据、候选 SHA、防过期裁决、双审门禁和按作者/仓库隔离的黄金集切分已实现。
- [x] 首批25条分层审核队列已生成；当前0条人工审核，未把候选或 AI 建议计作黄金语料。
- [x] DeepSeek prose/code 双路只读建议已实现；真实前三条试跑检出一路非法引用和一路语义冲突，均未写入正式标注。
- [x] 两份25条盲审包已生成并核验：候选一致，只保留原文、哈希、标题、语言和空白审核表，不泄漏来源、作者、评分或 AI 建议。
- [x] 真实黄金集整体评测器已接入第一动作、契约比较、程序反向语义、行为场景和变异测试；默认只跑 development，blind 需显式授权。
- [x] 三分支产品动作已真实调用验证：完整合成意图返回 `ready` 并通过语义门禁；泛化“做个BTC策略”返回具体问题；清晰的期权隐含波动率策略返回独立 `unsupported` 能力拒绝。

说明：V4 的 100/100 是固定合成语料上的工程回归结果，不是产品准确率，也不能替代真实用户语料、未见测试集和重复随机运行。
互联网小样同样只是未审核候选；审核基础设施虽已完成，但当前仍未形成黄金契约或真实准确率。

### 2.7 自然语言策略产品纵切

- [x] DeepSeek OpenAI-compatible Chat Completions provider，使用 JSON Output；对空白或非法 JSON 做一次格式重试。
- [x] OpenAI Responses API provider adapter，使用严格 JSON Schema 结构化输出，作为可选后备。
- [x] 默认 `deepseek-v4-pro`；provider/model 可通过环境变量或 CLI 覆盖，API Key 只从环境读取。
- [x] 模型生成完整策略源码、用户解释、假设、警告和变更摘要。
- [x] 模型同时输出独立的机器语义契约；平台从程序反向抽取语义并进行静态与动态双重核对。
- [x] 编译器增加完整 TypeScript 语义检查，可识别虚构 SDK 方法和错误决策类型。
- [x] 编译错误以 code/message/line/column 返回，并最多进入两轮定点修复。
- [x] 语义不一致也进入定点修复；信息不足返回 `needs_clarification` 和问题，能力不足返回 `unsupported` 和能力缺口，禁止偷偷用近似策略替代。
- [x] `new`、`revise`、`show` 本地 CLI；“把止损改成 3%”会创建新版本。
- [x] 策略版本使用不可变 JSON 文件，记录父版本、源码哈希、模型、修复历史、源码 diff 和回测摘要。
- [x] 新产品层已在本机 2020～2026 永续数据上复跑：报告 ID 与原基线一致，证明回测语义未改变。
- [x] DeepSeek 真实调用已验证：初始生成一次编译通过；“止损 5% 改为 3%”只修改版本和止损两行，未触发修复。
- [x] 新语义门禁已用 DeepSeek 真实调用验证：RSI、EMA+ATR 和 15m/已闭合 1h 多周期三类策略均零修复通过；模型契约、程序反向抽取和正反行为场景一致。
- [x] 修改后版本已接入 2020-01～2026-06 永续数据：3,417,120 根 1m、14,238 根 4h、135 笔交易，报告 ID `2e70fbf...d7a92`。
- [ ] OpenAI provider 尚未用真实 API Key 验证；不影响当前 DeepSeek 默认路径。
- [ ] 已有100条合成表达、495条互联网候选和25条待审队列，但尚无完成双审裁决的真实语料评测集和 Web 交互界面。

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
- [x] 已使用与现货字段匹配的 EMA 趋势基线完成有实际开平仓的年度回测。
- [x] 已生成固定 ID 的完整 JSON 报告、交易列表、权益曲线和核心指标。
- [x] 已用 stdlib-only Python 参考引擎逐交易、逐权益点交叉验证 Funding 和趋势策略。
- [x] 217 笔交易和 28,476 个权益点最大绝对差异均为 0。
- [ ] 数据解析、Parquet 和 1m→4h 聚合尚未由第二套实现独立验证。
- [ ] 尚未生成面向用户的可视化 HTML/Web 报告。

## 4. 规划中未完成

### P0：完成研究原型退出条件

这些工作完成前，不进入 Web MVP：

1. **长期永续数据集**
   - [已完成] 接入 Binance USD-M BTC 永续月度数据源。
   - [已完成] 同步成交 K 线、Funding 和 Mark Price，并披露 Mark 缺失回退。
   - [已完成] 现货与永续使用不同 venue/instrument，不静默替换。
   - [已完成] 生成 78 个不可变月分区和可复现 catalog。
   - [待完成] 接入可用时段内的 5m Open Interest。
   - [待完成] 增加当前月日包/REST 实时尾部，与完整月度事实集分层管理。

2. **有意义的真实策略基线**
   - [已完成] 增加不依赖 Funding 的趋势策略，在 2024 现货数据上完成有成交的回测。
   - 再用永续数据验证 Funding 策略。
   - [已完成] 输出 Net return、最大回撤、Sharpe、交易次数、胜率、费用、Funding 和滑点分项。

3. **回测性能与正确性**
   - [已完成] 复用持久 QuickJS Runtime，避免每根 Bar 重建沙箱。
   - [已完成] 使用增量 EMA 和逐 Bar 输入，避免复制全部历史和重复计算 EMA。
   - 增加保证金、爆仓、Maker/Taker、缺口政策和更真实滑点模型。
   - [已完成] 建立 Python 参考引擎，对 Funding 和趋势策略逐交易、逐权益点交叉验证。
   - [待完成] 用独立数据路径验证 CSV/Parquet 和周期聚合。
   - [待完成] 增加手算保证金、爆仓和 Bar 内冲突黄金案例。

4. **策略编译器完整性**
   - [已完成] 使用 Strategy SDK 声明执行完整 TypeScript 类型检查。
   - [部分完成] 已抽取可验证交易规则和动作；完整数据依赖、warm-up、状态键和能力等级仍待实现。
   - 为状态大小、输出大小和指标参数增加限制。

5. **黄金策略与测试集**
   - [已完成] 建立 20 条语义黄金策略和 100 条合成自然语言表达。
   - [已完成] 覆盖趋势、突破、均值回归、Funding、Long/Short、RSI、ATR、MACD、Bollinger Bands 和多周期。
   - [已完成] 为每条语义策略固定程序、机器契约、正反行为场景和变异预期。
   - [待完成] 增加状态策略、边界案例以及固定市场数据、程序哈希和完整回测结果。

6. **AI 生成闭环**
   - [已完成] 接入 DeepSeek 默认 provider 和 OpenAI 后备 provider；DeepSeek 已真实调用验证。
   - [已完成] 实现自然语言意图 → 候选程序 → 结构化编译错误 → 定点修复。
   - [部分完成] 已增加程序反向语义抽取、机器契约校验、行为场景、源码 diff 和不可变修改版本；用户确认 UI 未完成。
   - [已完成] 建立 100 条合成表达的离线语义评测集。
   - [已完成] 对 100 条合成意图完成 V2、V3、V4 三轮真实 DeepSeek 生成评测并记录准确率、自动修复、延迟、token 和成本；V4 全量 100/100 通过。
   - [部分完成] 已从互联网官方 API 和许可仓库采集首批真实公开表达候选；待扩展、人工标注至少150条，并建立不参与提示修订的独立测试集和重复运行稳定性评测。

7. **Paper Runtime 一致性**
   - 实现事件录制与 Replay。
   - 用同一录制数据验证 Backtest 与 Paper 信号一致。
   - 实现状态持久化、心跳、断线补放、暂停和恢复。

Phase 0 原定退出条件保持不变：20 条预设策略能够稳定编译，并在固定数据上复现结果。

### P1：封闭 MVP

- [ ] Web 产品：登录、对话策略编辑器、代码/解释视图、回测报告和数据图表。
- [ ] Control API、PostgreSQL 数据模型、对象所有权与幂等接口。
- [ ] 回测任务队列、配额、取消、重试和制品管理。
- [原型已完成] 策略不可变版本和源码比较；回滚与 Fork 未完成。
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

量化基础设施扩展暂时冻结；不优先增加 OI、L2、更多交易所、更多指标或爆仓模型，除非产品验证明确需要。

下一工作单元限定为：

> 将互联网公开表达候选扩展到约2,000条，人工审核250条并冻结150条带来源证据的黄金语料，对“生成成功率、自动修复率、语义保持、澄清正确性、延迟和单次成本”做可重复评测；随后把已经验证的 CLI 闭环包进最小 Web 对话界面。

V4 的 100 条合成表达已经形成工程回归基线；下一轮不再继续围绕同一固定语料调提示，避免对测试集过拟合。

固定样本内/样本外切分仍然重要，但它属于回测可信度的下一层工作，不再抢占自然语言产品闭环的当前优先级。

## 8. 常用验证命令

```bash
npm test
npm run typecheck
npm run semantics:golden

# 真实 DeepSeek 全量评测；支持断点续跑，报告默认不提交 Git
npm run semantics:deepseek -- --limit 100 --concurrency 6

DEEPSEEK_API_KEY="sk-..." npm run strategy:studio -- new \
  --intent "4 小时 20/50 EMA 金叉做多，止损 5%，死叉平仓" \
  --session btc-ema-v1 \
  --dataset data/history/binance-usdm/BTCUSDT-PERP/1m/dataset.catalog.json \
  --interval 4h

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
