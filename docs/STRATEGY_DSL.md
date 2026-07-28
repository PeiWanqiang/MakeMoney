# 策略 DSL 设计

> 状态说明：本设计不再作为用户策略的唯一承载形式。用户意图由 AI 生成的受约束策略程序表达；本文中的类型、数据依赖、能力分级、状态和动作模型继续作为内部 IR、审计与可视化参考。当前主设计见[策略程序设计](STRATEGY_PROGRAM.md)。

状态：Draft v0.1  
定位：平台最核心的产品与技术契约  
关联文档：[产品规格](PRODUCT_SPEC.md)｜[技术架构](TECH_ARCHITECTURE.md)

## 1. 核心问题

“DSL 如何覆盖用户自定义策略”不能靠不断增加 `emaCross`、`rsiOversold` 等模板解决。模板越多，组合越僵硬，最终只能覆盖演示用例。

但如果直接允许用户提交任意 Python/JavaScript，又会出现：

- 无法证明没有未来数据泄漏。
- Backtest、Paper 和 Live 语义不一致。
- 无法静态计算数据依赖和 warm-up。
- 无法解释某次订单为何产生。
- 任意网络、文件、时间、随机数和死循环风险。
- 无法对实盘代码做稳定的资源与权限限制。

因此采用的答案不是“只用 DSL”或“直接开放代码”，而是：

> 类型化声明式内核 + 可组合状态机 + 受限公式 + 经过认证的沙箱插件。

## 2. 覆盖目标与诚实边界

任何非图灵完备 DSL 都无法表达所有可能策略；一旦追求 100% 任意逻辑，它就会变成一门通用编程语言，并重新带回安全和可复现问题。

本平台的目标是：

- MVP 覆盖 80% 左右的单品种、Bar 级、因果规则策略。
- P1 覆盖 90% 左右的多周期、分批仓位和显式状态策略。
- P2 通过沙箱插件覆盖剩余可确定执行的策略。
- 高频做市、延迟套利、需要任意外部网络调用的策略明确不在核心范围。

这里的覆盖率最终不能凭感觉定义，需要用真实用户策略语料测量，见第 16 节。

## 3. 三层自定义能力

### Level 1：组合式 DSL

适用大多数用户：

- 选择数据和指标。
- 组合算术、比较和布尔条件。
- 使用跨周期、连续满足、发生后等待等时间语义。
- 定义状态、转换、下单动作和风险。

优势：完全可解释、可绘图、可回测、可模拟、可实盘。

### Level 2：受限公式特征

适用于内建指标没有覆盖，但逻辑仍是纯计算的用户：

```text
customMomentum =
  zscore(return(close, 12), 120)
  - 0.5 * zscore(funding_rate, 120)
```

允许：

- 数学运算。
- 滚动窗口。
- 条件表达式。
- 有限状态聚合。
- 已注册特征的组合。

禁止：

- 网络和文件访问。
- 当前系统时间。
- 非确定随机数。
- 无界循环和递归。
- 动态加载代码。
- 直接生成交易订单。

公式被解析为同一种表达式 AST，而不是通过 `eval` 执行。

### Level 3：沙箱插件

适用于复杂自定义指标、模型推理或特殊状态逻辑。

- 插件有显式输入输出 schema。
- 运行于隔离的 WASM sandbox 或等价确定性运行时。
- 有 CPU、内存、执行时间和输出大小限制。
- 默认 `BACKTEST_ONLY`。
- 通过因果性、确定性、资源、Paper 一致性和安全认证后，才能升级能力。

研究阶段可以提供隔离 Python notebook/import，但 Python 代码不直接进入 Live Runtime。要实盘必须迁移为受约束公式、平台内建特征或认证插件。

## 4. 七个正交语言层

一条策略不应被表示为一个巨大的 `entry` JSON。它由七层构成，每层只负责一种语义。

```text
1. Data Sources      数据从哪里来
2. Feature Graph     如何计算特征
3. Expression AST    条件是什么
4. Temporal Logic    条件在时间上如何成立
5. State Machine     策略当前处于什么状态
6. Actions           状态转换时做什么
7. Risk Envelope     即使策略想做，也最多能做什么
```

这种分层是覆盖自定义策略的关键：新数据、新指标、新时间条件和新执行动作可以分别扩展，而不是为每一种完整策略增加模板。

## 5. 数据层

### 5.1 数据引用

每个数据流使用强类型引用：

```json
{
  "id": "btc1h",
  "kind": "candle",
  "venue": "hyperliquid",
  "instrument": "BTC-PERP",
  "interval": "1h",
  "priceBasis": "mark"
}
```

支持逐步扩展：

- Candle/OHLCV。
- Trades 和 L2 book。
- Mark、Index、Oracle、Mid。
- Funding、Open Interest、Liquidations。
- 多交易场所基差。
- 链上数据。
- 经时间戳和版本管理的外部特征。

### 5.2 多周期

多周期不通过隐式 resample 实现。每个数据流声明自己的周期，对齐规则明确：

- 只能使用已经闭合的高周期 Bar。
- 1h 策略在 10:15 不能使用 10:00～11:00 的完整 1h Bar。
- DSL 明确 `onClose`、`onOpen` 或实时事件触发。

### 5.3 数据能力声明

策略编译后生成：

```json
{
  "requiredData": [
    { "kind": "candle", "interval": "15m", "lookback": 200 },
    { "kind": "candle", "interval": "4h", "lookback": 100 },
    { "kind": "funding", "lookback": 30 },
    { "kind": "open_interest", "lookback": 48 }
  ]
}
```

系统因此能在回测前判断数据是否足够，而不是运行到一半才失败。

## 6. 特征图

所有指标都是无副作用、可版本化的 Feature Node：

```json
{
  "id": "trendStrength",
  "op": "divide",
  "args": [
    { "op": "subtract", "args": ["ema20", "ema50"] },
    "atr14"
  ]
}
```

Feature Node 可以引用：

- 原始字段。
- 内建指标。
- 其他 Feature Node。
- 受限公式。
- 已认证插件输出。

编译器将特征图转换为 DAG，完成：

- 拓扑排序。
- 公共子表达式复用。
- 类型和单位检查。
- warm-up 计算。
- 因果性检查。
- Backtest/Paper/Live 能力检查。

## 7. 类型与单位系统

只检查 `number` 不够。DSL 至少需要以下逻辑类型：

- `Price<USD>`
- `Quantity<BTC>`
- `Notional<USD>`
- `Ratio`
- `Percent`
- `RatePer8h`
- `Duration`
- `BarCount<1h>`
- `Timestamp`
- `Boolean`
- `Side`
- `OrderType`

这能阻止类似错误：

- 把价格与百分比直接相加。
- 把 8 小时 funding 当作年化率比较。
- 把 15m 的 20 bars 与 4h 的 20 bars 当成相同周期。
- 用 BTC 数量填写 USD 名义金额。

单位转换必须显式存在于 IR，不能由 LLM 猜测。

## 8. 表达式 AST

### 8.1 原子表达式

```json
{ "ref": "ema20" }
{ "const": 0.05, "unit": "percent" }
{ "account": "equity" }
{ "position": "unrealizedPnlPercent" }
```

### 8.2 算术与比较

```json
{ "op": "sub", "args": [{ "ref": "ema20" }, { "ref": "ema50" }] }
{ "op": "gt", "args": [{ "ref": "oiChange24h" }, { "const": 0.05 }] }
```

### 8.3 布尔组合

```json
{
  "op": "all",
  "args": [
    { "op": "crossesAbove", "args": [{ "ref": "ema20" }, { "ref": "ema50" }] },
    { "op": "lt", "args": [{ "ref": "funding" }, { "const": 0 }] }
  ]
}
```

表达式 AST 比固定模板更能组合，也比文本公式更适合静态校验、可视化和跨语言执行。

## 9. 时间语义

交易策略的难点往往不是指标，而是“何时算成立”。时间必须是一等公民。

需要支持：

- `crossesAbove(a, b)`：本事件发生交叉。
- `rising(x, bars)`：连续或总体上升。
- `forBars(condition, n)`：连续 n 根成立。
- `count(condition, window) >= n`：窗口内至少 n 次。
- `withinBars(a, b, n)`：a 发生后 n 根内 b 发生。
- `since(event)`：自某事件后的值或时间。
- `oncePer(duration)`：限频。
- `cooldownAfter(event, bars)`：事件后冷却。
- `atTime/session`：在明确时区和交易会话触发。
- `debounce`：信号稳定后才触发。

示例：“4小时趋势向上，并且15分钟突破发生在资金费率转负后的8根K线内”：

```json
{
  "op": "all",
  "args": [
    { "op": "gt", "args": [{ "ref": "btc4h.ema20" }, { "ref": "btc4h.ema50" }] },
    {
      "op": "withinBars",
      "first": { "op": "crossesBelow", "args": [{ "ref": "funding" }, { "const": 0 }] },
      "then": { "op": "crossesAbove", "args": [{ "ref": "close15m" }, { "ref": "high20" }] },
      "bars": 8,
      "clock": "btc15m"
    }
  ]
}
```

## 10. 显式状态机

仅有 entry/exit 无法覆盖以下策略：

- 止损后冷却。
- 分批建仓和减仓。
- 首次突破与二次回踩采用不同逻辑。
- 盈利后移动保护线。
- 连续亏损后降风险。
- 等待订单完成再进入下一阶段。

因此策略本体应是有限状态机：

```json
{
  "initialState": "FLAT",
  "states": {
    "FLAT": {
      "transitions": [
        {
          "when": { "ref": "longSetup" },
          "actions": [
            { "type": "open", "side": "long", "size": { "ref": "riskSize" } }
          ],
          "to": "LONG_PENDING"
        }
      ]
    },
    "LONG_PENDING": {
      "transitions": [
        { "on": "order.filled", "to": "LONG" },
        { "on": "order.rejected", "to": "COOLDOWN" }
      ]
    },
    "LONG": {
      "transitions": [
        {
          "when": { "ref": "partialTakeProfit" },
          "actions": [{ "type": "reduce", "percent": 0.5 }],
          "to": "LONG_PROTECTED"
        },
        {
          "when": { "ref": "hardExit" },
          "actions": [{ "type": "close", "percent": 1 }],
          "to": "COOLDOWN"
        }
      ]
    },
    "LONG_PROTECTED": {
      "transitions": [
        {
          "when": { "ref": "trailingExit" },
          "actions": [{ "type": "close", "percent": 1 }],
          "to": "COOLDOWN"
        }
      ]
    },
    "COOLDOWN": {
      "transitions": [
        { "afterBars": 12, "to": "FLAT" }
      ]
    }
  }
}
```

状态必须有限且可枚举。MVP 不允许动态创建无限状态。

## 11. 动作系统

策略只产生 Order Intent，不直接调用交易所。

首批动作：

- `open`
- `close`
- `reduce`
- `increase`
- `placeLimit`
- `cancel`
- `moveStop`
- `setTakeProfit`
- `setStateVar`
- `notify`

每个动作有明确前置条件和结果事件。比如 `open` 可能返回 pending、filled、partial、rejected；状态机不能假定下单等于成交。

动作参数也可以是表达式，例如：

```json
{
  "type": "open",
  "side": "long",
  "size": {
    "op": "positionSizeForRisk",
    "riskPercent": 0.01,
    "entryPrice": { "ref": "markPrice" },
    "stopPrice": { "ref": "initialStop" }
  }
}
```

## 12. 状态变量

有限状态机之外，需要少量有类型的持久变量：

```json
{
  "variables": {
    "lossStreak": { "type": "integer", "initial": 0, "min": 0, "max": 20 },
    "highestSinceEntry": { "type": "price", "initial": null },
    "entriesToday": { "type": "integer", "initial": 0, "min": 0, "max": 100 }
  }
}
```

更新只能通过受限 reducer：

- `set`
- `increment/decrement`
- `min/max`
- `resetOn`
- `rollingAggregate`

禁止动态对象、无界数组和任意内存分配。

## 13. 风险层不是用户策略的一部分

策略可以声明期望风险，但平台 Risk Envelope 独立存在并具有更高优先级。

```text
最终可执行动作
  = Strategy Intent
  ∩ User Risk Policy
  ∩ Platform Risk Policy
  ∩ Venue Capability
  ∩ Jurisdiction Policy
```

这样用户即使写出“100倍杠杆全仓做多”，DSL 可以成功理解其意图，但编译或实盘风控仍会拒绝。

风险策略不得由自定义插件覆盖。

## 14. 特征与插件注册表

每个内建或插件特征必须注册以下元数据：

```json
{
  "featureId": "core.ema",
  "version": "1.2.0",
  "inputs": [{ "name": "source", "type": "Series<Price>" }],
  "paramsSchema": {
    "length": { "type": "integer", "minimum": 1, "maximum": 10000 }
  },
  "output": "Series<Price>",
  "causal": true,
  "deterministic": true,
  "warmup": "length - 1",
  "runtimeSupport": ["backtest", "paper", "live"],
  "implementationHash": "...",
  "testVectorVersion": "ema-v3"
}
```

核心字段：

- 输入输出类型和单位。
- 参数范围。
- warm-up 公式。
- 是否因果、是否确定。
- 可运行的模式。
- 实现版本和测试向量。
- CPU/内存预算。

插件升级不会静默改变旧策略；旧策略固定依赖版本，用户主动升级后产生新策略版本。

## 15. 能力分级与实盘认证

每条策略在编译后获得能力级别：

### `BACKTEST_ONLY`

包含以下任一情况：

- 使用研究型 Python 代码。
- 数据只能历史获得，不能实时获得。
- 使用非因果或无法证明因果的特征。
- 资源消耗不受限。
- 插件尚未完成认证。

### `PAPER_ELIGIBLE`

- 所有数据可以实时获得。
- 计算确定且有资源上限。
- 允许使用尚未完成长期一致性验证的插件。

### `LIVE_ELIGIBLE`

要求：

- 所有节点因果、确定且版本固定。
- 无网络、文件、系统时钟和非确定随机数。
- Backtest replay 与 Paper 事件回放结果一致。
- 插件通过资源和安全扫描。
- 策略动作受 venue adapter 支持。
- 风险门禁完整。

能力只能由编译器和认证系统计算，LLM 或用户不能自行声明。

## 16. 覆盖率如何测量

建立真实策略语料库，而不是只写团队自己想到的策略。

### 16.1 数据集

首阶段收集至少 500 条用户策略，覆盖：

- 技术指标。
- Funding/OI。
- 多周期。
- 突破、回踩和均值回归。
- 分批入场和退出。
- 时间、冷却和交易次数限制。
- 仓位和动态风险。
- 多品种、价差和组合。
- 外部事件、新闻和自定义模型。

每条策略由人工标注：

- 可直接表达。
- 需要澄清。
- 需要公式扩展。
- 需要插件。
- 明确不支持。

### 16.2 指标

- `Exact coverage`：无语义损失直接表达。
- `Clarified coverage`：用户确认有限假设后表达。
- `Formula coverage`：需要受限公式。
- `Plugin coverage`：需要插件。
- `Unsupported rate`。
- `Silent semantic loss`：系统声称成功但改变了策略含义，目标必须接近零。
- `Round-trip agreement`：DSL 重新解释成自然语言后，用户确认含义一致。

### 16.3 上线门槛

- 核心目标用户策略的 `Exact + Clarified coverage >= 80%`。
- `Silent semantic loss < 1%`，且所有高风险差异必须为零。
- 所有无法表达部分提供结构化原因，而不是编造近似策略。
- 每个新增算子必须增加黄金样例、反例和跨运行时一致性测试。

## 17. 自然语言编译流水线

```text
Natural language
  -> Intent extraction
  -> Ambiguity detection
  -> Clarification contract
  -> Candidate typed AST
  -> Schema validation
  -> Semantic and unit validation
  -> Causality and data validation
  -> Capability classification
  -> Canonical IR
```

LLM 只参与前四步。后续步骤全部由确定性编译器完成。

### 17.1 澄清契约

用户输入：“放量突破就做多，跌破趋势就离场。”

系统不能自行选择参数，而应返回：

```json
{
  "ambiguities": [
    {
      "id": "volume_definition",
      "question": "How should high volume be measured?",
      "options": [
        "volume > 1.5 × 20-bar average",
        "volume z-score > 2 over 100 bars"
      ]
    },
    {
      "id": "breakout_level",
      "question": "What price level defines the breakout?",
      "options": ["20-bar high", "50-bar high", "custom"]
    },
    {
      "id": "trend_exit",
      "question": "What defines the trend break?",
      "options": ["close below EMA50", "close below latest swing low", "custom"]
    }
  ]
}
```

每个假设由用户确认后才进入策略版本。

### 17.2 反向解释

编译完成后，系统从 DSL 而不是原始输入生成解释：

> On every completed 1-hour BTC bar, open a long position only when...

用户确认的是实际将被执行的逻辑，防止“模型理解了”和“系统执行了”之间存在隐形差异。

## 18. 多语言与可视化

DSL 自身不包含自然语言文案。中文、英文和其他语言都编译到同一种 AST。

由于所有节点有类型和元数据，可以从同一 DSL 生成：

- 自然语言说明。
- 规则树。
- 数据依赖图。
- 图表信号标记。
- 风险摘要。
- 版本 diff。
- 审计解释。

这也是选择结构化 DSL 而不是保存一段生成代码的重要产品价值。

## 19. 版本与兼容性

策略身份包含：

- DSL schema version。
- 每个 feature/operator version。
- 编译器版本。
- Canonical IR hash。
- 数据 schema/version。
- runtime engine version。

规则：

- 旧版本继续使用原语义。
- 破坏性语义变更必须提升主版本。
- 自动迁移只能生成新草稿，不能覆盖运行中版本。
- Live 策略固定 IR hash，修改后必须重新回测和审批。

## 20. 分阶段语言范围

### MVP

- 单 venue、单 instrument。
- 单一主时钟，可引用闭合高周期数据。
- 内建技术指标、Funding、OI。
- 算术、比较、布尔和基本时间算子。
- Flat/Pending/Long/Short/Cooldown 标准状态。
- 单仓位、止盈止损、追踪止损、固定或风险百分比仓位。
- 不开放用户代码。

### P1

- 完整显式状态机。
- 分批入场和退出。
- 有限状态变量。
- 受限公式特征。
- 多周期和有限多品种引用。
- 插件 Research/Paper sandbox。

### P2

- 认证 WASM 插件。
- 多资产、价差与组合级状态。
- 外部特征的时间版本和可用性证明。
- 创作者共享的特征包。
- 更丰富的订单和 venue capability negotiation。

### 长期明确排除

- 用户任意代码直接进入 Live Runtime。
- 无法重放的外部信号直接实盘。
- 自修改策略绕过版本和重新审批。
- 插件访问钱包、密钥或 Execution Service。
- 无界资源和亚毫秒高频策略。

## 21. 最关键的产品体验

用户不应该感觉自己在学习一门 DSL。正常流程是：

1. 用户用自然语言描述策略。
2. 系统只询问会改变交易含义的问题。
3. 页面展示可视化规则和关键假设。
4. 用户可以用对话或表单修改任一节点。
5. 系统明确说明当前策略是 Backtest、Paper 还是 Live eligible。
6. 高级用户可以展开 DSL、公式和版本 diff。

DSL 是平台内部可信契约，而不是强迫普通用户编程的界面。

## 22. 当前架构决策

1. 不以固定策略模板作为核心抽象。
2. 不允许 LLM 生成任意代码后直接执行。
3. 使用类型化表达式 AST 和显式时间算子。
4. 使用有限状态机表达路径依赖策略。
5. 使用 Feature Registry 扩展指标和数据。
6. 使用能力分级隔离研究、模拟和实盘。
7. 用真实用户策略语料持续衡量覆盖率。
