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
- [回测引擎独立交叉验证](docs/CROSS_VALIDATION.md)

## 已确定的核心原则

1. AI 生成受约束的 TypeScript 策略程序，不直接提交订单。
2. 策略程序经过静态检查、版本哈希和沙箱执行；回测、模拟盘和实盘共用同一程序语义。
3. 默认模拟盘；实盘必须经过显式授权和独立风控。
4. 首个交易场所为 Hyperliquid，首批品种为 BTC、ETH、SOL 永续合约。
5. 产品不托管用户资产，不接收助记词或主钱包私钥。
6. 优先建立可信回测、真实运行记录和高质量市场数据库。

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
```

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
