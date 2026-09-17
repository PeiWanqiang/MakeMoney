# 泛化架构整体实施方案

状态：执行中  
适用范围：自然语言意图、策略契约、编译器、运行时、回测服务、Web、数据、缓存、优化、Paper、Live、测试与文档。  
准入规范：[GENERALIZATION_POLICY.md](GENERALIZATION_POLICY.zh-CN.md)

## 1. 通用能力定义

平台把任意受支持的单品种、因果、事件驱动交易意图编译为一个版本化语义制品。该制品必须同时决定数据需求、计算表达式、时间语义、状态变化、交易动作、风险意图和可运行模式；产品解释、回测、优化、Paper 与 Live 只能消费这一制品，不得重新解释自然语言或维护近似语义。

这一定义不以某个用户原句、标的、周期、指标、方向、语言或样例常量为边界。无法进入版本化语义制品并被确定性执行的能力继续标记为 `unsupported`。

## 2. 当前基线与要解决的问题

保留的可靠基础：

- 受限 TypeScript、AST 安全检查和完整 TypeScript 类型检查。
- QuickJS/WASM 隔离、资源限制和结构化决策校验。
- 确定性 Bar 回测、下一根 Bar 开盘成交、多周期闭合规则。
- 数据集哈希、Parquet 分区、基础独立参考引擎交叉验证。

需要替换的架构形态：

- 模型同时生成 TypeScript 和字符串条件契约，形成双事实源。
- Web 与 Node Service 各自解释一部分策略和优化语义。
- 能力枚举、指标列表、时间周期、输出 Schema 和校验规则分散复制。
- 策略版本和缓存没有绑定 SDK ABI、Runtime、数据清单与完整程序身份。
- 单元测试覆盖很多局部实现，但缺少跨层能力一致性门禁。

## 3. 目标架构

```text
自然语言
  -> IntentResult（ready / needs_clarification / unsupported）
  -> StrategySemanticIR v2
  -> 确定性编译器
       -> 受限 TypeScript Program
       -> CapabilityManifest
       -> DataRequirements
       -> ExplanationModel
       -> ParameterSchema
  -> StrategyArtifactManifest
  -> 统一 Event Kernel
       -> Backtest Adapter
       -> Recorded Replay / Paper Adapter
       -> Live Adapter
  -> 独立 Risk Engine
  -> Order Intent / 审计事件
```

### 3.1 `StrategySemanticIR v2`

IR 是模型意图、编译器反抽取和产品解释共用的类型化语义，不再在 `when: string[]` 中嵌一门自由文本语言。

至少包含：

- `schedule`：触发事件、主周期、闭合规则、时区与会话。
- `data`：venue、instrument、字段、price basis、lookback、对齐和缺失政策。
- `features`：版本化 Feature DAG、参数、输出类型、单位和 warm-up。
- `expressions`：数值、比较、布尔和受限时间表达式 AST。
- `state`：键、类型、初始值、读取和写入效果。
- `actions`：open、close、reduce、increase、moveStop 等版本化动作。
- `riskIntent`：策略请求的仓位/止损语义；平台风险上限与它分离。
- `modeEligibility`：BACKTEST_ONLY、PAPER_ELIGIBLE、LIVE_ELIGIBLE 及原因。
- `unsupported`：缺少的通用原语和明确拒绝理由。

模型生成的 IR 与编译器从程序产生的 IR 使用同一 Schema，进行结构化比较。无法反抽取的高级程序不能伪装成完全可解释策略；它只能进入受限能力等级或被拒绝。

### 3.2 Capability Registry

每个能力只注册一次，注册项包含：

- 稳定 ID 和版本。
- 输入/输出类型与单位。
- 数据依赖和 warm-up 计算。
- SDK 声明与 Runtime 实现。
- IR 编译/反抽取处理器。
- UI 标签与解释投影。
- 优化器是否允许暴露参数。
- Backtest/Paper/Live 能力等级。
- 原始回归、参数变体、结构变体和边界测试集合。

SDK declaration、模型可用能力、JSON Schema、UI 能力表和测试矩阵由 Registry 派生，禁止继续手写多份枚举。

### 3.3 Strategy Artifact Manifest

每个可运行版本必须保存：

- `semanticIrVersion`、`semanticHash`。
- `source`、`programHash`、`compilerVersion`。
- `sdkAbiHash`、`runtimeVersion`、`capabilityVersions`。
- `dataRequirementsHash`、`modeEligibility`。
- 父版本、生成来源、用户确认和迁移来源。

回测结果的身份键必须由以下内容共同决定：

```text
artifactManifestHash
+ datasetManifestHash
+ backtestConfigHash
+ executionPolicyVersion
```

不能仅用契约、提示词版本或手工引擎字符串代表执行语义。

### 3.4 单一执行内核

- Web 只做身份、权限、确认、任务编排和展示。
- Strategy Service 负责生成、编译、验证、版本物化和能力判断。
- Backtest Service 负责数据解析和统一 Event Kernel。
- Web 不保留契约回测器、指标实现或本地优化执行回落。
- Service 不可用时 fail closed；不能生成空源码 `ready` 版本。
- Backtest、Replay/Paper、Live 共享相同策略调用、状态提交、Risk Engine 和 Order Intent 规则，只替换事件源与成交适配器。

### 3.5 数据语义

- 调用方传 `datasetRef`，不把一组未声明能力的 Bar 当作完整数据语义。
- Dataset Manifest 声明字段、单位、来源、时间覆盖、对齐方式、缺口和哈希。
- 编译得到的 `DataRequirements` 在执行前与 Dataset Manifest 做确定性匹配。
- `markPrice -> close`、缺 Funding 取零等回退必须成为显式、版本化执行政策；默认缺失关键字段应拒绝执行。

## 4. 分阶段实施

### Phase 0：正确性止血与共享边界（当前开始）

目标：停止继续制造跨层漂移，为 IR v2 迁移建立可信边界。

- [x] 模型制品、Verify 和 Optimization 共用一个运行时 `StrategyContract v1` 解析器。
- [x] 模型输出 Schema/解析器补齐 `equityPercent` 和表达式化风险字段。
- [x] Web 回测缓存绑定实际存储源码摘要并升缓存版本。
- [x] Backtest Service 校验 wire schemaVersion、编译后 sourceHash、行情顺序/OHLC 边界和配置范围。
- [x] Verify/Optimization/Blind/Materialize 校验各自 wire schemaVersion 和完整策略契约。
- [ ] 结果制品加入统一 Execution Manifest；缓存改用 Manifest hash。
- [ ] 未配置服务时禁止新增 `ready`、回测、优化和空源码版本。
- [ ] 删除旧路径前完成历史制品审计、迁移清单和只读兼容策略。

退出门槛：跨层能力一致性测试覆盖三种仓位、常量/表达式风险字段、部分平仓、非法版本、源码哈希不一致、乱序/非法 Bar；根与 Web 全量回归通过。

### Phase 1：`StrategySemanticIR v2` 最小纵切

先迁移一条完整但非样例专用的能力集合：

- OHLCV/指标数据引用。
- 数值四则运算和单位。
- 比较、AND/OR/NOT、Cross。
- open/close/partial close。
- 一个显式状态键与状态写入效果。
- 常量、权益比例、风险比例仓位和计算止损。
- 单周期和已闭合高周期读取。

工作项：

1. 定义 JSON Schema 与运行时 validator，并从 Schema 生成 TypeScript 类型。
2. 模型先生成 IR；常见策略由确定性 lowering 生成 TypeScript。
3. 编译器从 TypeScript 生成同一 IR，结构比较替代字符串 canonical 比较。
4. Explanation 和 Parameter Schema 改为消费 IR。
5. v1 契约进入显式只读 adapter；不静默升级无法证明等价的历史制品。

退出门槛：每个迁移能力均通过意图、IR、程序、解释、回测、持久化和缓存的同一能力矩阵；v1/v2 结果不串缓存。

### Phase 2：控制面和执行面收敛

1. Web analyze 改调 Strategy Service，删除独立 SYSTEM_PROMPT、输出解析和修复循环。
2. Web 回测/优化强制调用 Service，删除 `IndicatorEngine`、`runContractBacktest` 和字符串参数解释器。
3. 数据所有权移入 Backtest Service，Web 只传 datasetRef 和窗口。
4. 任务改为异步 job：幂等、配额、取消、重试、进度和不可变收据。
5. D1/PostgreSQL 保存显式版本列；大制品进对象存储，数据库保存 Manifest 和引用。

退出门槛：生产路径没有第二执行器和未验证回落；相同 Artifact/Dataset/Config 在 CLI、API、Web 得到同一结果身份和逐事件输出。

### Phase 3：统一 Replay/Paper 内核

1. 定义不可变 Market、Timer、Order、Fill、Position、Risk 事件 envelope。
2. Backtest 改为事件源 Adapter，不改策略和状态提交逻辑。
3. 实现录制事件 Replay 和 Paper Adapter。
4. Risk Engine 对请求仓位产生 approved/reduced/rejected 结果，不再在回测内部静默截断。
5. 同一录制数据逐信号、逐 Order Intent、逐状态提交比较 Backtest 与 Paper。

退出门槛：确定性 Replay 零差异；重启、重复事件、断线补放和状态恢复有边界测试。

### Phase 4：Live 准入与能力扩展

只有通过 Registry 的 LIVE_ELIGIBLE 能力进入实盘。增加任何新指标、时间逻辑、动作或数据源时，必须同时提供：

- 通用能力定义。
- 类型、单位、数据与时序。
- 编译/反抽取/Runtime 实现。
- Backtest/Paper 一致性证据。
- Explanation、版本、缓存和文档变更。
- 回归、参数变体、结构变体、边界拒绝和既有回归。

## 5. 迁移和兼容原则

- v1 制品不可原地覆盖；迁移生成新版本并保留父哈希。
- 能证明结构等价的 v1 规则可确定性迁移；其余保留只读或重新确认。
- 历史回测收据永远按原 Engine/SDK/Data 版本展示，不用新语义重算后冒充原结果。
- 迁移期 Shadow 只用于观测差异，不能作为用户执行回落。
- 每完成一个 Phase，删除已经无调用方的旧实现和测试；不长期维护双栈。

## 6. 测试与评测门禁

建立三类互补门禁：

1. **能力矩阵**：每个 Registry 能力跨意图、IR、程序、运行、解释、持久化验证。
2. **变形/属性测试**：变量重命名、等价括号、条件顺序、数值变体、方向/周期/语言变化不得改变不相关语义。
3. **真实冻结评测**：人工双审并裁决的 development/validation/blind 集；固定回归与盲测分开报告。

高风险语义还必须具备手算小数据、独立参考实现和 Backtest/Paper 录制回放一致性。

## 7. 首批变更的适用层确认

本轮 Phase 0 适用层：

- 意图：模型输出 Schema 和解析能力同步。
- 契约/类型：统一 v1 runtime parser。
- 编译/校验：sourceHash 由服务编译结果决定。
- 执行：不改变既有成交语义，只拒绝非法输入。
- 产品：回测收据记录 source digest；用户解释暂不变。
- 数据/缓存：缓存绑定源码，非法/乱序 Bar 被拒绝。
- 文档：本方案记录能力边界和后续迁移。

本轮不宣称完成：IR v2、单一 Web 执行器、Paper/Live 一致性、Dataset Manifest 强制匹配。它们保持为明确的后续发布门禁。
