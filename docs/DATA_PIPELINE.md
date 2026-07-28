# BTC 一分钟历史行情管线

状态：Implemented v0.1

## 结论

底层只保存 1m K 线。15m、1h、4h 都由同一份 1m 快照确定性聚合，禁止把不同供应商、不同交易场所的周期 K 线静默混用。

十年 BTC 现货研究数据的权威主线选 Kraken `XBTUSD`。Kraken 官方提供从各市场开始至今的完整 OHLCVT ZIP，并按季度发布增量；其 BTC/USD 市场足以覆盖 2016–2026 十年。快速开发和逐年验证使用 Binance Vision `BTCUSDT` 月包，因为它按月分发、每个文件提供 SHA-256，而且下载速度快。

两条序列不能自动拼接：`XBTUSD` 与 `BTCUSDT`、Kraken 与 Binance 都有基差和微观结构差异。数据目录始终保留 `source`、`venue`、`instrument`，策略回测必须显式选择数据集。

官方依据：

- [Kraken 可下载 OHLCVT 历史数据](https://support.kraken.com/articles/360047124832-downloadable-historical-ohlcvt-open-high-low-close-volume-trades-data)
- [Binance Public Data 说明与校验方式](https://github.com/binance/binance-public-data)
- [Coinbase Exchange candles API 备用方案](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles)

## 已实现能力

- 官方 ZIP 流式读取，不把十年 CSV 一次性载入内存。
- 按月 Parquet 分区；单分区损坏不会使整个十年数据集报废。
- Binance 官方 `.CHECKSUM` SHA-256 校验。
- Parquet 自身 SHA-256、分区 manifest、全局 dataset catalog。
- 下载 `.part` 文件和 HTTP Range 断点续传。
- 已存在分区在重跑时先校验哈希，然后跳过。
- 毫秒/微秒时间戳兼容，统一转为 UTC epoch milliseconds。
- 重复、非法 OHLC、分钟缺口检测。
- 不完整的聚合桶不会进入 15m/1h/4h 回测。

## 本地验证结果

2024 年 Binance Spot `BTCUSDT` 已在本机完整跑通：

| 项目 | 结果 |
|---|---:|
| 1m 行数 | 527,040 |
| 理论分钟数 | 527,040 |
| 缺失分钟 | 0 |
| Parquet 分区 | 12 |
| 1h 完整聚合桶 | 8,784 |
| 不完整 1h 桶 | 0 |
| ZIP 缓存体积 | 31 MB |
| Parquet + manifest 体积 | 19 MB |

本地数据位于 `data/`，已加入 `.gitignore`，不会提交到 Git。

## 使用方式

### 一年快速验证

```bash
npm run data:binance-history -- \
  --symbol BTCUSDT \
  --start 2024-01-01T00:00:00Z \
  --end 2025-01-01T00:00:00Z
```

`--end` 为开区间。输出目录默认为 `data/history/binance-spot/BTCUSDT/1m`。

### 十年单一交易所数据

```bash
npm run data:kraken-history -- \
  --pair XBTUSD \
  --start 2016-01-01T00:00:00Z \
  --end 2026-01-01T00:00:00Z
```

程序默认尝试续传 Kraken 官方页面所链接的完整 ZIP。Google Drive 若要求交互确认，先从上述 Kraken 官方页面手动下载，再运行：

```bash
npm run data:kraken-history -- \
  --archive /absolute/path/Kraken_OHLCVT.zip \
  --pair XBTUSD \
  --start 2016-01-01T00:00:00Z \
  --end 2026-01-01T00:00:00Z
```

Kraken 官方明确说明：无成交的分钟不会出现在 CSV 中。我们保留这个事实，不默认伪造 K 线。catalog 中的 `observedMissingMinutes` 会反映未观测分钟；需要连续时间网格的研究任务，应在派生层显式选择“前值填充、成交量为 0”，并把该转换写入回测 manifest。

### 回测

```bash
npm run backtest:real -- \
  data/history/binance-spot/BTCUSDT/1m/dataset.catalog.json 4h
```

现有示例策略依赖永续合约资金费，而 Binance/Kraken 这两个十年数据集是现货数据，因此它在该数据集上可能不交易。这不是行情错误；长周期永续研究还需单独接入合约 K 线、资金费、标记价格和合约换代信息。

## 生产环境演进

本地 Parquet 是回测事实源；上线后把同样的分区和 manifest 上传对象存储，ClickHouse 只作为查询加速层。每日增量采集继续写新的不可变分区，禁止覆盖历史文件；供应商修订数据时产生新 snapshot ID，并使旧回测仍可复现。
