# 互联网策略意图语料库

状态：采集管线 v0.1 已实现并完成真实 API 小样验证  
目标：从授权清晰的公开互联网内容中建立可追溯、可去重、可审计的自然语言策略候选池

## 1. 数据口径

互联网公开内容属于“真实用户公开表达”，不等于作者确认过的完整意图，也不自动成为黄金答案。

数据依次经过：

```text
官方 API / 明确许可仓库
  -> 原始候选与来源证明
  -> 许可证门禁
  -> 策略相关性评分
  -> 精确与近似去重
  -> 人工语义审核
  -> 黄金契约与行为场景
  -> 冻结评测集
```

当前代码已完成“去重候选集”和“可审计人工标注工具”。候选必须经过人工证据标注和裁决，才能进入真实评测集。

## 2. 当前启用的数据源

### Stack Exchange

- 使用官方 Stack Exchange API `search/advanced`。
- 首批覆盖 Stack Overflow `pine-script` 和 Quantitative Finance Stack Exchange。
- 保存问题链接、必要的作者归属和适用的 CC BY-SA 版本。
- 每个查询页完成后原子保存数据并写 checkpoint。

许可说明：<https://stackoverflow.com/help/licensing>

### GitHub

- 使用官方 GitHub REST API 搜索公共仓库并读取 README。
- 只接受 `MIT`、`Apache-2.0`、`BSD-2-Clause`、`BSD-3-Clause`、`ISC`、`CC0-1.0` 和 `Unlicense`。
- 无许可证、未知许可证和归档仓库直接拒绝。
- 默认查询要求 README 同时包含 Entry/Exit 或 Buy/Sell 等规则性表达，减少通用框架仓库噪声。
- `GITHUB_TOKEN` 可选；未配置时使用较低的公共 API 配额。

许可 API：<https://docs.github.com/en/rest/licenses/licenses>

## 3. 暂不自动采集的数据源

- Reddit：商业和 AI 相关数据用途需要额外许可，当前不采集。
- TradingView：当前条款严格限制机器处理和内容复用，只用于人工发现主题。
- X、YouTube、Discord、Telegram：在取得适当 API、平台或作者许可前不进入自动管线。

## 4. 数据结构

每条 JSONL 记录包括：

- 稳定候选 ID、来源记录 ID 和 URL。
- 发布时间、采集时间、来源 Host。
- 原始相关文本及 SHA-256。
- 语言、标签、相关性得分和触发信号。
- 许可证、归属文本和作者来源。
- GitHub 仓库、默认分支和 README 路径。
- 人工审核状态。

联系信息、邮箱、钱包、账户或交易凭据不属于采集字段。作者显示名只为满足来源归属要求。

## 5. 使用命令

```bash
# Stack Exchange：默认4组查询，每组最多50条
npm run intents:collect-stackexchange -- --pages 1 --page-size 50

# GitHub：默认4组严格 README 查询；配置 Token 可提高 API 配额
GITHUB_TOKEN="..." npm run intents:collect-github -- --pages 1 --page-size 25

# 合并、重新评分并跨来源去重
npm run intents:filter -- --minimum-score 0.3 --near-threshold 0.9

# 为一名独立审核者生成25条分层队列
npm run intents:review -- queue --reviewer reviewer-1 --limit 25

# 查看进度
npm run intents:review -- stats

# 为审核队列生成 DeepSeek 双路只读建议
npm run intents:suggest -- --limit 25 --concurrency 2
```

默认文件：

```text
data/internet-intents/raw/stackexchange.jsonl
data/internet-intents/raw/github.jsonl
data/internet-intents/candidates/candidates.jsonl
data/internet-intents/candidates/summary.json
data/internet-intents/review/annotations.jsonl
data/internet-intents/review/queue-reviewer-1.json
data/internet-intents/golden/golden.jsonl
data/internet-intents/golden/manifest.json
```

整个目录被 Git 忽略。重复执行相同查询时会读取 checkpoint，不重新请求已经完成的页。

## 6. 已完成的小样验证

2026-07-30 使用未认证 GitHub API 和 Stack Exchange 官方 API：

- Stack Exchange：多组查询前三页，经来源 ID 合并后保存493条。
- GitHub：两轮小样共检查40个搜索结果，10个唯一仓库通过许可证白名单；其余主要因无明确许可被拒绝。
- 两源合计503条原始记录；相关性阈值过滤后495条候选。
- 候选来源：Stack Exchange 486条、GitHub 9条。
- 许可证：CC BY-SA 4.0 485条、CC BY-SA 3.0 1条、MIT 9条。
- 472条候选被规则评分为高相关，23条为可能相关；文本长度中位数约1,159字符。
- 重复运行全部命中 checkpoint，没有重复请求。

以上495条尚未人工审核，不应报告为“495条真实黄金策略”。

## 7. 审核和黄金集质量门禁

队列中的每条记录同时包含只读 `candidate` 和待填写 `review`。审核者需要：

1. 保持 `candidateId` 和 `candidateSha256` 不变。
2. 把 `status` 改为 `submitted`，填写 ISO 格式的 `submittedAt`。
3. 选择 `ready`、`needs_clarification`、`unsupported` 或 `not_strategy`。
4. 标注至少一个原文证据区间。`quote` 必须逐字符等于 `rawText.slice(start, end)`，`supports` 说明该区间支持什么事实。
5. `ready` 必须填写规范化意图和 `StrategyContract`；缺少关键参数时标为 `needs_clarification` 并写明问题；引擎能力不足时标为 `unsupported` 并列出能力缺口。

将单条 `review` 对象另存为 JSON 后提交：

```bash
npm run intents:review -- submit --file review.json
```

不同审核者使用不同 `reviewerId` 独立提交。裁决者在同样的数据结构中把 `kind` 改为 `adjudication`，并在 `basedOnReviewIds` 中列出所参考的独立审核 ID。新独立意见提交后，旧裁决会自动失效，避免裁决基于过期意见。

正式黄金集默认要求至少两名不同审核者和一份裁决：

```bash
npm run intents:review -- export
```

仅用于验证工作流的单人试点必须显式降低门槛：

```bash
npm run intents:review -- export --minimum-reviewers 1 --require-adjudication false
```

导出时再次验证原文 SHA、证据区间、状态字段和契约结构。`not_strategy` 作为过滤依据保留在标注记录中，但不进入黄金策略集。开发、验证和盲测按作者分组；GitHub 内容按仓库分组，同一作者或仓库不会跨集合泄漏。导出清单记录质量门槛、各类数量和整个 JSONL 的 SHA-256。

这个流程验证的是“黄金答案确实来自用户原文”，并不能仅凭一条回测收益证明翻译正确。后续评测仍需同时检查：黄金契约差异、生成代码静态语义、确定性行为场景和变异测试。

### AI 双路建议

`intents:suggest` 先用确定性规则把混合内容分为 prose 和 code 两路，再独立调用 DeepSeek。每路都可以给出四种 disposition、原文证据、缺失问题或建议契约。系统只把建议写入：

```text
data/internet-intents/review/suggestions.jsonl
```

它不会写入 `annotations.jsonl`，也没有提交审核的代码路径。建议中的每个引用仍须逐字符存在于候选原文中；模型改写引用、返回非法状态或无效契约时，该路标为 `error`，命令以失败状态退出，下次运行会重试。两路 disposition 或契约不一致时标为 `conflict`，不自动合并。一路文本不足时标为 `unavailable`，整体为 `insufficient`。

2026-07-30 对真实队列前三条做最小试跑：一条只有 prose 建议；一条代码路首次因非原文引用被质量门禁拒绝，断点重试后通过；一条 Pine 排错样本在 prose/code 间出现 disposition 冲突。最终结果为1条 agree、1条 conflict、1条 insufficient、0条 lane error。结果证明该层能暴露混合文本歧义，但这些结果仍不是人工审核或黄金标签。

## 8. 下一阶段

1. 扩展到约2,000条候选，并补充有明确许可证的中文来源。
2. 对自然语言与附带代码做独立双路语义抽取，作为审核者参考而非黄金答案。
3. 人工双审250条并完成争议裁决，形成约150条黄金语料。
4. 使用当前 V4 评测器运行真实互联网语料，并独立报告高、中、低置信度结果。
