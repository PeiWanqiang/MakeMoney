# 策略程序设计

状态：Implemented local product slice v0.3
核心选择：AI 生成受约束 TypeScript，平台编译、审计并在 QuickJS/WASM 沙箱运行

## 1. 为什么从 DSL 转向程序

交易策略天然包含条件、局部变量、历史窗口、状态和复杂控制流。继续扩展 JSON DSL，最终会重新创造一门表达能力不足的编程语言。

当前方案是：

```text
用户自然语言
  -> AI 同时生成机器语义契约与 TypeScript 策略程序
  -> AST 静态安全检查
  -> TypeScript 编译
  -> 从程序反向抽取语义并与契约逐条核对
  -> 自动生成正例、逐条件反例和变异测试
  -> 内容哈希和能力分析
  -> QuickJS/WASM 沙箱
  -> 结构化 Order Intent
  -> 独立 Risk Engine
```

程序解决表达能力，SDK 和沙箱解决可控性，独立风险层解决“程序即使表达成功，也不能任意下单”。

## 2. 用户程序形态

```ts
defineStrategy({
  id: "example.ema-funding",
  name: "EMA crossover with negative funding",
  version: 1,

  onBar(ctx) {
    const fast = ctx.indicators.ema("close", 20);
    const fastPrevious = ctx.indicators.ema("close", 20, 1);
    const slow = ctx.indicators.ema("close", 50);
    const slowPrevious = ctx.indicators.ema("close", 50, 1);

    if (
      ctx.position.side === "flat" &&
      ctx.market.fundingRate < 0 &&
      ctx.crossedAbove(fast, fastPrevious, slow, slowPrevious)
    ) {
      return {
        type: "open",
        side: "long",
        size: { kind: "riskPercent", value: 0.01 },
        stopLossPercent: 0.02,
        takeProfitRiskReward: 2,
        reason: "EMA crossover with negative funding"
      };
    }

    return { type: "hold" };
  }
});
```

普通用户不必看代码。产品展示自然语言解释、关键条件、风险和回测结果；高级用户可以展开、编辑和 Fork 程序。

## 3. Strategy SDK 是产品边界

程序不能直接访问交易所。平台只提供版本化的 `ctx`：

- `ctx.market`：当前已经发生的市场事件。
- `ctx.indicators`：确定性指标和历史窗口。
- `ctx.history`：受限的 OHLCV、Mark、Funding、OI 数组和 Bar 窗口。
- `ctx.timeframe("1h")`：读取另一个周期已经闭合的 market、indicators 和 history；不会暴露尚未闭合的高周期 Bar。
- `ctx.position`：只读仓位快照。
- `ctx.account`：只读账户权益。
- `ctx.state.get/set`：显式、JSON 可序列化的持久状态。
- `ctx.crossedAbove/Below`：通用辅助函数。

程序只能返回结构化决策：

- `hold`
- `open`
- `close`
- 后续增加 `reduce`、`increase`、`moveStop` 等

Runtime 将决策转换为 Order Intent。Risk Engine 可以拒绝或缩减，程序没有交易凭据。

## 4. 为什么不是直接执行普通代码

普通代码默认拥有过多能力。当前编译器会拒绝：

- import 和 dynamic import。
- fetch、WebSocket 和网络访问。
- process、require 和 Node 运行时。
- Date、performance 和非确定时钟。
- eval、Function 和动态代码生成。
- new、prototype 和 constructor 访问。
- 循环和无界计算；首版全部禁止循环。
- 任意成员赋值；持久状态只能通过 `ctx.state.set`。

运行时还有第二层限制：

- QuickJS 运行于 WebAssembly 隔离环境。
- 每次调用有 CPU 时间上限。
- 每次调用有内存上限。
- 不注入文件、网络、进程、钱包或交易对象。
- 输出必须通过运行时 schema 校验。

静态检查用于给出清晰错误，沙箱和资源限制才是执行安全边界。

## 5. 确定性和版本

每个编译后的程序具有 SHA-256 哈希。回测记录至少固定：

- 原始策略版本。
- 编译后程序哈希。
- Strategy SDK 版本。
- Runtime 版本。
- 数据快照哈希。
- 费用、滑点和 Funding 配置。

同一个程序、同一个数据快照和同一配置必须产生相同决策、订单和结果。

当前 Bar Runtime 采用：

- 在已经闭合的 Bar 上运行策略。
- 本 Bar 收盘生成决策。
- 下一根 Bar 开盘执行。
- 同一 Bar 同时触发止损止盈时，保守地假设止损先发生。
- Funding、费用和滑点显式计入。

## 6. 状态策略

程序可以自然表达 DSL 难以处理的路径依赖：

```ts
const losses = ctx.state.get("consecutiveLosses", 0);

if (losses >= 3) {
  return { type: "hold", reason: "cooldown after three losses" };
}
```

持久状态必须：

- 通过显式 API 读写。
- 只包含 JSON 值。
- 在每个事件后保存。
- 在 Backtest、Paper 和 Live 使用相同语义。
- 有大小和更新频率上限。

后续可增加受限事件入口：`onOrderUpdate`、`onPositionUpdate`、`onTimer`，但每个入口仍是确定性事件处理函数。

## 7. 内部 IR 的新角色

不再要求把程序完整翻译为 JSON DSL。内部 IR 只抽取平台必须理解的部分：

- 数据依赖和 warm-up。
- 使用的 SDK 能力。
- 可能产生的 Order Intent 类型。
- 状态键及其类型。
- Backtest/Paper/Live 能力等级。
- 风险声明。
- 程序哈希和版本。

无法静态抽取的内容可以通过运行时证据补充，但不能因此绕过风险层。

## 8. AI 生成与修复循环

```text
用户意图
  -> AI 生成候选程序 + 独立机器语义契约
  -> 编译器返回结构化错误
  -> AI 只修复错误位置
  -> 从程序反向抽取规则，与契约逐条比较
  -> 契约自动生成正例和逐条件反例
  -> 变异测试确认周期、方向、仓位、止损等错误会被拒绝
  -> 从已验证契约生成用户解释
  -> 用户确认
```

模型需要获得：

- 完整 SDK 类型声明。
- 可运行示例。
- 禁止能力清单。
- 目标 Runtime 版本。
- 结构化编译错误。

AI 不能根据失败结果偷偷改变策略含义。信息缺失或歧义时必须返回 `needs_clarification` 和明确问题；意图清晰但当前 SDK 无法覆盖时必须返回 `unsupported` 和缺失能力，不能改成“最接近”的替代策略。任何语义修改都要在 diff 和反向解释中显示。

## 9. 当前代码结构

```text
src/
  compiler/
    validate-strategy-source.ts  # AST策略和安全检查
    compile-strategy-source.ts   # TS编译、规范化、SHA-256
  runtime/
    sandbox.ts                   # QuickJS/WASM隔离运行
    backtest.ts                  # 确定性Bar级回测
  semantics/
    contract.ts                  # 机器语义契约
    extract-semantics.ts         # 从程序反向抽取交易规则
    scenario-runner.ts           # 契约驱动的正反行为场景
    mutation-testing.ts          # 周期/方向/仓位/止损等故障注入
    golden-cases.ts              # 20条策略、100条合成表达
  core/types.ts                  # 决策、仓位、成交和结果
  strategy-sdk.ts                # 提供给AI和编辑器的程序接口
examples/
  strategies.ts                  # 黄金策略程序
  run-demo.ts                    # 端到端示例
test/
  source-validation.test.ts
  sandbox.test.ts
  backtest.test.ts
```

## 10. 当前已实现

- DeepSeek V4 Pro 默认 provider 和 OpenAI Responses API 后备 provider。
- `ready / needs_clarification / unsupported` 三分支产品动作，追问与能力拒绝使用独立字段。
- 自然语言生成、结构化编译诊断和最多两轮定点修复。
- 完整 TypeScript 语义类型检查，可阻止模型虚构 SDK 方法。
- 反向解释、假设、警告、变更摘要和源码 diff。
- 不可变策略会话版本以及可选真实数据回测制品。
- 单一 `defineStrategy` 程序入口。
- TypeScript AST 解析与禁止能力检查。
- TypeScript 到 JavaScript 编译。
- SHA-256 程序版本。
- QuickJS/WASM 执行、内存和时间限制。
- OHLCV、Funding 和 OI 上下文。
- SMA、EMA、highest、lowest、percentChange、standardDeviation、RSI、ATR、MACD、Bollinger Bands。
- 受限历史数组和 Bar 窗口。
- 1m、15m、1h、4h 多周期读取，并执行已闭合 Bar 防未来数据规则。
- 模型语义契约、程序反向语义抽取和逐规则比较。
- 契约驱动的正反场景验证与自动变异测试。
- 20 条语义黄金策略、100 条合成表达、123 个场景和 100 个必杀变异。
- DeepSeek 真实烟测已覆盖 RSI、EMA+ATR 和 15m 检查/已闭合 1h 信号，三类均零修复通过完整语义门禁。
- DeepSeek 真实批量评测支持内容指纹、断点续跑、并发、token/延迟/成本记录和离线语义重算；全量结果由 V2 的 86/100、V3 的 94/100 提升到 V4 的 100/100。
- V4 全量 100 条中有 21 条经过自动修复，0 条契约错配、0 条生成错误、0 条 provider 错误；该结果只代表固定合成回归集，不代表真实用户准确率。
- 契约比较器会规范化空白、常见 Cross 写法、多周期 Cross 写法和关系比较的等价左右换位，避免把 `close < lower` 与 `lower > close` 误报为不同策略。
- 显式持久状态。
- Hold/Open/Close 决策校验。
- 下一根 Bar 开盘成交。
- 仓位、止损止盈、Funding、费用和滑点。
- 确定性回归和初步沙箱逃逸测试。

## 11. 下一步

完整进度和优先级以[项目状态与后续工作](PROJECT_STATUS.md)为准。当前策略程序侧的未完成事项为：

1. 停止继续针对固定合成集调参；从授权清晰的互联网公开表达构建带来源证据的冻结评测集，验证语义保持、澄清率、修复率、延迟、成本和重复运行稳定性。
2. 把当前规则抽取扩展为完整 SDK 能力、数据依赖和 warm-up 分析。
3. 增加 Reduce、Increase、MoveStop 动作。
4. 给黄金策略增加固定市场数据、程序哈希和完整回测结果，并补充状态与边界案例。
5. 把本地 CLI 纵切包装为最小 Web 对话体验。
6. 用同一录制数据验证 Backtest Replay 与 Paper Runtime 一致。

## 12. 不变的安全原则

即使程序表达能力很强，以下能力永远不交给用户程序：

- 钱包密钥。
- 交易所 API 客户端。
- 绕过 Risk Engine 的下单路径。
- 转账和提现。
- 任意网络与文件访问。
- 修改自身代码或运行版本。
- 修改平台级风险参数。
