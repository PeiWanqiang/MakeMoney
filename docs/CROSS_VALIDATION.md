# 回测引擎独立交叉验证

状态：Implemented v0.1  
参考引擎：Python stdlib-only `python-reference-0.1.0`  
主引擎：TypeScript/QuickJS `0.2.0`

## 目标

确定性只能证明同一实现会稳定重复结果，不能证明实现正确。项目因此维护第二套不导入 TypeScript Runtime 的 Python 参考引擎，独立实现：

- EMA 初始化和递推。
- Cross Above/Below。
- Bar 收盘信号和下一 Bar 开盘成交。
- Long/Short 方向和风险仓位。
- Taker fee 和固定 bps 滑点。
- Funding 的方向、Mark Price 名义金额和累计。
- 止损、止盈、信号平仓和期末平仓。
- 同 Bar 止盈止损冲突时止损优先。

比较器逐笔核对交易方向、进出时间、成交价、数量、Gross PnL、Funding、费用、滑点、Net PnL 和退出原因，并逐点核对权益曲线。默认容差为绝对 `1e-8`、相对 `1e-10`；任何超差都会生成失败报告并让命令返回非零。

## 已完成验证

数据集：`binance-usdm-btcusdt-perp-1m-2020-01-2026-06`  
周期：4h  
权益点：每个策略 14,238

| 策略 | 交易数 | 交易字段最大差异 | 权益最大差异 | 状态 |
|---|---:|---:|---:|---|
| EMA + negative Funding | 82 | 0 | 0 | PASS |
| Long-only 20/50 EMA | 135 | 0 | 0 | PASS |

Funding 报告 ID：`d2d885663677bb7933380082760afaf8d81f0c67a7d77ed5833fa38411da61ff`  
趋势报告 ID：`6ce34c9a660f1d0a917350605ad02f31756edca91e7ea381df0aa372f10fcda2`

报告固定记录 Python 源码 SHA-256、输入 fixture SHA-256、78 个数据分区哈希、策略程序哈希、引擎版本、配置、容差和所有差异。

## 使用方式

```bash
npm run backtest:cross-validate -- \
  data/history/binance-usdm/BTCUSDT-PERP/1m/dataset.catalog.json \
  4h \
  funding

npm run backtest:cross-validate -- \
  data/history/binance-usdm/BTCUSDT-PERP/1m/dataset.catalog.json \
  4h \
  trend
```

实现：

- `reference/python_reference_backtest.py`：独立 Python 引擎。
- `scripts/cross-validate-backtest.ts`：固定输入、运行两个引擎、逐字段比较和生成报告。
- `test/reference-backtest.test.ts`：每次 `npm test` 都执行的跨语言回归。

## 验证边界

当前 Python 引擎接收 TypeScript 数据层已经聚合好的 Bar，因此本轮独立验证覆盖“策略指标与回测执行语义”，不独立覆盖：

- ZIP/CSV 解析。
- Parquet 编解码。
- 1m 到 4h 聚合。
- Mark Price 缺失回退。
- 数据源本身是否正确。
- 保证金和爆仓；主引擎当前也未实现完整模型。

两套实现也可能对同一份错误规格做出一致结果。后续仍需用手算小样本、交易所规则案例和第三方结果进行验证，不能把 `PASS` 等同于所有回测语义已经正确。
