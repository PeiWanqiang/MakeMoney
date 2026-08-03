"use client";

import { useEffect, useRef } from "react";
import type { Time } from "lightweight-charts";

/**
 * `[timestamp, open, high, low, close]`, as the API sends it.
 *
 * The series arrive as numeric rows rather than objects: at the 10,000-bar cap
 * the repeated field names cost more than the prices. The columns are named in
 * the response's `series` block, and the rows are read straight into the
 * charting library's own shape below.
 */
export type BacktestBar = [number, number, number, number, number];

/** `[timestamp, equity]`, decimated server-side to what the line can resolve. */
export type EquityPoint = [number, number];

export interface BacktestTrade {
  side: "long" | "short";
  entryTimestamp: number;
  exitTimestamp: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  grossPnl: number;
  fees: number;
  slippageCost: number;
  netPnl: number;
  exitReason: string;
}

interface Props {
  bars: BacktestBar[];
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  asset: string;
}

function chartTime(timestamp: number): Time {
  return Math.floor(timestamp / 1000) as Time;
}

export default function BacktestChart({ bars, trades, equityCurve, asset }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || bars.length === 0) return;
    let disposed = false;
    let cleanup = () => {};

    void import("lightweight-charts").then(({ CandlestickSeries, ColorType, LineSeries, createChart, createSeriesMarkers }) => {
      if (disposed) return;
      const chart = createChart(container, {
        width: container.clientWidth,
        height: 610,
        layout: { background: { type: ColorType.Solid, color: "#ffffff" }, textColor: "#6f7889", panes: { separatorColor: "#e2e5ec", separatorHoverColor: "#1b4fd6", enableResize: true } },
        grid: { vertLines: { color: "#eef0f4" }, horzLines: { color: "#eef0f4" } },
        crosshair: { vertLine: { color: "#9aa2b1", labelBackgroundColor: "#1b4fd6" }, horzLine: { color: "#9aa2b1", labelBackgroundColor: "#1b4fd6" } },
        rightPriceScale: { borderColor: "#e2e5ec" },
        timeScale: { borderColor: "#e2e5ec", timeVisible: true, secondsVisible: false, rightOffset: 5 },
        localization: { locale: "zh-CN" },
      });
      const candles = chart.addSeries(CandlestickSeries, {
        upColor: "#0f7a4d",
        downColor: "#c1362a",
        borderUpColor: "#0f7a4d",
        borderDownColor: "#c1362a",
        wickUpColor: "#3f9b71",
        wickDownColor: "#cf6255",
        priceLineVisible: true,
      }, 0);
      candles.setData(bars.map(([timestamp, open, high, low, close]) => ({ time: chartTime(timestamp), open, high, low, close })));
      const equity = chart.addSeries(LineSeries, {
        color: "#1b4fd6",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        title: "账户权益",
      }, 1);
      equity.setData(equityCurve.map(([timestamp, value]) => ({ time: chartTime(timestamp), value })));
      createSeriesMarkers(candles, trades.flatMap((trade, index) => [
        {
          time: chartTime(trade.entryTimestamp),
          position: trade.side === "long" ? "belowBar" as const : "aboveBar" as const,
          color: "#141926",
          shape: trade.side === "long" ? "arrowUp" as const : "arrowDown" as const,
          text: `${trade.side === "long" ? "买入" : "做空"} ${index + 1}`,
        },
        {
          time: chartTime(trade.exitTimestamp),
          position: trade.side === "long" ? "aboveBar" as const : "belowBar" as const,
          color: trade.netPnl >= 0 ? "#0f7a4d" : "#c1362a",
          shape: "circle" as const,
          text: `${trade.netPnl >= 0 ? "+" : ""}${trade.netPnl.toFixed(0)}`,
        },
      ]).sort((left, right) => Number(left.time) - Number(right.time)));

      chart.subscribeCrosshairMove((parameter) => {
        const tooltip = tooltipRef.current;
        if (!tooltip || !parameter.time || !parameter.point) {
          if (tooltip) tooltip.hidden = true;
          return;
        }
        const data = parameter.seriesData.get(candles) as { open?: number; high?: number; low?: number; close?: number } | undefined;
        if (!data?.close) {
          tooltip.hidden = true;
          return;
        }
        tooltip.hidden = false;
        tooltip.style.left = `${Math.min(container.clientWidth - 190, Math.max(12, parameter.point.x + 16))}px`;
        tooltip.style.top = `${Math.max(12, parameter.point.y - 52)}px`;
        tooltip.textContent = `${asset}\nO ${data.open?.toFixed(2)} · H ${data.high?.toFixed(2)}\nL ${data.low?.toFixed(2)} · C ${data.close.toFixed(2)}`;
      });
      chart.timeScale().fitContent();
      const panes = chart.panes();
      if (panes[0]) panes[0].setHeight(430);
      const observer = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth }));
      observer.observe(container);
      cleanup = () => {
        observer.disconnect();
        chart.remove();
      };
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [asset, bars, equityCurve, trades]);

  return (
    <div className="chart-shell">
      <div className="chart-legend" aria-hidden="true">
        <span><i className="entry-dot" />开仓（箭头朝上做多、朝下做空）</span>
        <span><i className="win-dot" />盈利平仓</span>
        <span><i className="loss-dot" />亏损平仓</span>
        <span><i className="equity-dot" />账户权益曲线</span>
      </div>
      <div ref={containerRef} className="backtest-chart" aria-label={`${asset} K线、交易标记与权益曲线`} />
      <div ref={tooltipRef} className="chart-tooltip" hidden />
    </div>
  );
}
