# Crypto Strategy Studio

一个面向国际加密交易者的自然语言策略平台：把交易想法编译为可验证、可模拟、可受控执行的确定性策略。

当前阶段是本地产品纵切原型，暂不使用最终品牌名。

## 核心文档

- [产品规格](docs/PRODUCT_SPEC.md)
- [策略程序设计](docs/STRATEGY_PROGRAM.md)
- [内部 DSL/IR 设计](docs/STRATEGY_DSL.md)
- [技术架构](docs/TECH_ARCHITECTURE.md)
- [商务与市场方案](docs/BUSINESS_PLAN.md)
- [历史行情数据管线](docs/DATA_PIPELINE.md)
- [当前项目状态与后续工作](docs/PROJECT_STATUS.md)
- [互联网策略意图语料库](docs/INTERNET_INTENT_CORPUS.md)
- [回测引擎独立交叉验证](docs/CROSS_VALIDATION.md)
- [泛化优先准入规范](docs/GENERALIZATION_POLICY.md)

## 已确定的核心原则

1. AI 生成受约束的 TypeScript 策略程序，不直接提交订单。
2. 策略程序经过静态检查、版本哈希和沙箱执行；回测、模拟盘和实盘共用同一程序语义。
3. 默认模拟盘；实盘必须经过显式授权和独立风控。
4. 首个交易场所为 Hyperliquid，首批品种为 BTC、ETH、SOL 永续合约。
5. 产品不托管用户资产，不接收助记词或主钱包私钥。
6. 优先建立可信回测、真实运行记录和高质量市场数据库。
7. 所有修复必须实现样例背后的通用语义能力；禁止按原句、常量或单一策略打补丁，完整准入门槛见[泛化优先准入规范](docs/GENERALIZATION_POLICY.md)。

## 自然语言策略闭环

本地 CLI 已打通第一条产品主路径：自然语言意图 → DeepSeek/OpenAI 同时生成机器语义契约与受约束 TypeScript → AST/完整 TypeScript 类型检查 → 从程序反向抽取规则 → 契约逐条比对与正反行为场景 → 最多两次定点修复 → 解释与假设 → 不可变策略版本 → 可选真实数据回测。用户修改会生成新版本和源码 diff，旧版本文件不会被覆盖；当前能力无法覆盖的意图会明确要求澄清，不会静默改成近似策略。

```bash
export DEEPSEEK_API_KEY="sk-..."

# 创建策略；不传 --dataset 时只生成、检查并保存策略版本
npm run strategy:studio -- new \
  --intent "4 小时级别，20 EMA 上穿 50 EMA 做多，止损 5%，下穿平仓" \
  --session btc-ema-v1 \
  --dataset data/history/binance-usdm/BTCUSDT-PERP/1m/dataset.catalog.json \
  --interval 4h

# 对话式修改会创建不可变的新版本
npm run strategy:studio -- revise \
  --session btc-ema-v1 \
  --intent "把止损改成 3%"

# 查看最新版本，或通过 --version 查看指定历史版本
npm run strategy:studio -- show --session btc-ema-v1
```

默认 provider/model 为 DeepSeek `deepseek-v4-pro`，可用 `--provider deepseek|openai` 和 `--model` 覆盖；使用 OpenAI 时设置 `OPENAI_API_KEY`。API Key 只从环境读取，不写入会话制品。为兼容只保存 Key 主体的旧环境，DeepSeek provider 会在内存中补全缺失的 `sk-` 前缀，但不会修改环境或落盘。策略会话位于 `data/strategy-sessions/`，默认被 Git 忽略。

Strategy SDK 已支持 SMA、EMA、RSI、ATR、MACD、Bollinger Bands、标准差、最高/最低、涨跌幅、历史数组/Bar，以及 1m、15m、1h、4h 多周期读取。高周期数据只有在对应 Bar 闭合后才会进入策略，避免未来数据泄漏。

```bash
# 复跑20条语义黄金策略、123个正反场景和100个错误变体
npm run semantics:golden

# 用真实 DeepSeek 跑100条合成自然语言表达；报告支持断点续跑
npm run semantics:deepseek -- --limit 100 --concurrency 6
```

真实模型评测会记录每条样例的契约差异、修复次数、延迟、token 和估算成本，默认写入 Git 已忽略的 `data/reports/semantic-evals/`。DeepSeek V4 Pro 的全量结果由 V2 的 86/100、V3 的 94/100 提升到 V4 的 100/100；V4 中有 21 条经过自动修复，0 条契约错配、生成错误或 provider 错误。该结果只来自固定合成表达，不能替代真实用户语料、未见测试集和重复运行稳定性评测。

## 互联网真实表达采集

首批互联网采集使用 Stack Exchange 官方 API 和有明确许可证的 GitHub README；Reddit、TradingView 等来源在取得相应许可前不进入自动采集。采集结果包含来源、许可证、哈希、相关性评分和 checkpoint，并在跨来源过滤后去重。机器筛选结果只是候选，不自动成为黄金策略。

```bash
npm run intents:collect-stackexchange -- --pages 1 --page-size 50
GITHUB_TOKEN="..." npm run intents:collect-github -- --pages 1 --page-size 25
npm run intents:filter -- --minimum-score 0.3 --near-threshold 0.9

# 生成可审计人工审核队列；AI 双路建议只供参考，不会写入正式标注
npm run intents:review -- queue --reviewer reviewer-1 --limit 25
npm run intents:suggest -- --limit 25 --concurrency 2

# 黄金集冻结后运行真实意图整体引擎评测（默认不碰盲测集）
npm run intents:evaluate -- --split development --concurrency 2
```

数据默认写入 Git 已忽略的 `data/internet-intents/`。完整来源边界、格式和验证结果见[互联网策略意图语料库](docs/INTERNET_INTENT_CORPUS.md)。

## 本地数据与回测

原始行情统一为 1 分钟 K 线，再确定性聚合为 15m、1h 和 4h。项目已实际下载并验证 Binance Spot `BTCUSDT` 的 2024 全年数据：527,040 根、12 个 Parquet 月分区、0 个缺失分钟。

```bash
# 快速构建/续传一年 BTC 1m 数据集
npm run data:binance-history -- \
  --symbol BTCUSDT \
  --start 2024-01-01T00:00:00Z \
  --end 2025-01-01T00:00:00Z

# 构建 2020 年至最后一个完整月份的 BTCUSDT 永续数据集
npm run data:binance-perp-history -- \
  --symbol BTCUSDT \
  --start 2020-01-01T00:00:00Z \
  --end 2026-07-01T00:00:00Z

# 用目录清单中的真实数据回测；先聚合为 4h
npm run backtest:real -- \
  data/history/binance-spot/BTCUSDT/1m/dataset.catalog.json 4h

# 用独立 Python 引擎逐交易、逐权益点交叉验证
npm run backtest:cross-validate -- \
  data/history/binance-usdm/BTCUSDT-PERP/1m/dataset.catalog.json 4h funding

# 导入 Kraken 单一市场的十年 BTC/USD 1m 数据
npm run data:kraken-history -- \
  --start 2016-01-01T00:00:00Z \
  --end 2026-01-01T00:00:00Z
```

下载器会校验源文件、按月写入不可变 Parquet、生成数据哈希和总目录，并在重跑时验证后续传。Kraken 的自动下载若被 Google Drive 拦截，可从官方页面下载完整 ZIP 后通过 `--archive /absolute/path/Kraken_OHLCVT.zip` 导入。

## 产品主路径

```text
自然语言想法
  -> AI 生成/定点修复策略程序
  -> 静态安全与完整类型校验
  -> 反向解释、假设和不可变版本
  -> 程序哈希/内部 IR
  -> 历史回测
  -> 样本外验证
  -> 实时模拟盘
  -> 风险审核
  -> 用户授权实盘
  -> 持续监控与复盘
```

## 许可证

本项目采用 [MIT 许可证](LICENSE)。

本软件仅供研究和信息用途，不构成投资建议。加密货币交易存在亏损全部本金的风险，使用者需自行承担实盘交易的全部后果。
