# 策略指标依赖数据字段清单

状态：Inventory v0.1（2026-08-04，基于 `src/data/` 与 `web/worker/backtest-api.ts` 核对）

目标：为策略指标依赖提供尽可能完整的基础行情字段，明确「已拿到」「源里有但当前丢弃」「结构性拿不到」三类。

## 1. 已拿到（已在库，`data/history/` 管线）

| 字段 | Binance Spot BTCUSDT 2024 | Binance USD-M BTCUSDT-PERP 2020–2026 | Kraken XBTUSD 2016–2026 | Hyperliquid 近期 |
|---|---|---|---|---|
| Open / High / Low / Close | ✓ | ✓ | ✓（代码就绪，ZIP 未跑通） | ✓ |
| Volume（base 成交量） | ✓ | ✓ | ✓ | ✓ |
| Trades（笔数） | ✓（Binance 第 8 列） | ✓ | ✓（OHLCVT 的 T） | ✓（candle `n`） |
| Funding Rate | —（现货恒 0） | ✓（7,119 事件，按结算分钟） | — | ✓（逐小时事件，按 bar 求和） |
| Funding Premium | — | — | — | ✓ |
| Mark Price | — | ✓（0.38% 缺失，集中在 8 个月，回退成交收盘并披露） | — | — |

数据质量：分钟缺口检测、重复/非法 OHLC 检测、不完整聚合桶不入回测、SHA-256 + catalog manifest 均已实现。

## 2. 源里有但当前丢弃（免费补，已实现 2026-08-04）

Binance K 线归档/接口是 12 列，`parseBinanceKline`（`src/data/historical-dataset.ts`）此前只读 0–5 + 8。Spot 月包与 USD-M 月包**同一个 ZIP 里还有**：

| 列 | 字段 | 含义 | 状态 |
|---|---|---|---|
| 7 | `quote_asset_volume` | 成交额（quote 计价，**换手率的基础分母**） | ✓ 已入库 |
| 8 | `number_of_trades` | 笔数 | ✓ 已存（原已有） |
| 9 | `taker_buy_base_volume` | 主动买量（base） | ✓ 已入库 |
| 10 | `taker_buy_quote_volume` | 主动买成交额（quote） | ✓ 已入库 |

**实现落点（2026-08-04）**：
- `MarketBar` 增加 `quoteVolume?`、`takerBuyBaseVolume?`、`takerBuyQuoteVolume?`（`src/core/types.ts`）。
- `parseBinanceKline` 补读 7/9/10 列（`src/data/historical-dataset.ts`）。
- Parquet 快照按需写入/读回三列，旧分区无此列仍可读（`src/data/market-snapshot.ts`）。
- 聚合 15m/1h/4h 时求和透传（`src/data/aggregate-bars.ts`）。
- SDK / 沙箱 / 编译器声明 / prompt 暴露 `market.quoteVolume`、`market.takerBuyBaseVolume`、`market.takerBuyQuoteVolume`（`market.*` 与 `history.*` 均可引用；未提供时为 `null`），并可作为 `sma/ema/highest/lowest/standardDeviation/bollingerBands/percentChange` 的字段入参。
- 测试：解析、快照往返、聚合求和已覆盖（`test/historical-data.test.ts`）。

存量 ZIP 只需重跑解析（下载缓存仍在，`data/cache/`），不需要重新下载。当前实现为可选字段：非 Binance 来源（Kraken/HL）不携带，策略读到 `null`。

Web 侧 `parseKlineRows`（`web/worker/backtest-api.ts:781`）仍只读前 6 列；Phase 5 数据所有权并入服务后由服务统一承担，无需单独修。注意：**在 Web 引擎被 Path A 替换前，Web 回测还不能解释 `market.quoteVolume` 等新字段条件**（会按无法解释拒绝）；CLI/沙箱已完全支持。

## 3. 结构性拿不到 / 源受限（试了多次拿不到或 1m 全程根本不存在）

| 字段 | 结论 | 原因 |
|---|---|---|
| Open Interest 1m 全程 | **拿不到** | Binance USD-M 官方长期归档从 ~2021 才开始、且是 **5m 日包**；REST `openInterestHist` 单次仅 30 天。2020 全年及更早无 1m。Hyperliquid OI 只有当前快照（`metaAndAssetCtxs`），无历史。 |
| Mark Price 无缺失全程 | **拿不到** | 8 个月有 0.38% 缺失，只能回退成交收盘 + 披露，原始值补不回来。 |
| 换手率（基于流通盘） | **无此原始字段** | 加密永续没有权威流通盘口径；交易所只给 `quote_asset_volume`。"换手率"只能自定义派生（如 `quoteVolume / N 日均量`），属于派生指标。 |
| L2 深度/订单簿历史 | **拿不到** | Spot 无长期归档；USD-M `bookDepth` 快照文件巨大、覆盖有限，无法支撑 2020 起 1m 全程。 |
| 爆仓事件历史 | **拿不到** | 交易所只有实时 WebSocket，无历史归档。 |
| 逐笔成交历史（2020 起全程） | **拿不到/不现实** | 归档覆盖不全或体积不可控；产品 Bar 级引擎不需要。 |
| 多空持仓比 / 账户比值历史 | **受限** | Binance REST 仅 top trader 口径、单次 30 天窗口，回填工作量大且不完整。 |

> 注：Kraken 十年与 Hyperliquid 长历史属于"源存在但本机未跑通/未接入"，不是"拿不到"，见 §4。

## 4. 可拿但需要新下载工作量（不是拿不到，按需排期）

| 字段 | 来源 | 工作量 |
|---|---|---|
| Index / Oracle 价格 | Binance USD-M `indexPriceKlines` REST（与已接的 `markPriceKlines` 同构）；HL oracle 走其 API | 新下载脚本 + 缺口处理 |
| Open Interest 5m（2021+ 部分年份） | `openInterestHist` 逐月回填 | 大量请求 + 5m→1m 对齐策略 |
| Hyperliquid 全量历史 | HL 官方数据桶（S3） | 新接入器 + 体积评估 |
| 主动买卖比派生指标 | §2 的 taker buy 字段 | 随 §2 一并获得，零额外源 |

## 5. 建议优先级

1. **立即（半天）**：§2 四个字段入库——同一 ZIP 免费拿，直接解锁成交额/主动买卖比等指标依赖。
2. **随 Path A 一并**：数据所有权并入 Backtest Service，字段 schema 统一在 `src/contracts/`，Web 不再各存各的。
3. **按产品需求排期**：Index 价格、OI 5m、HL 全量历史（§4）。
4. **明确不做**：L2 历史、爆仓历史、逐笔全程（§3），除非产品验证明确要求。
