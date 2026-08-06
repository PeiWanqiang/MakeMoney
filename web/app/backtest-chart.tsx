"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Time } from "lightweight-charts";
import { getMessages } from "./i18n";
import { LOCALE_TAG, type Locale } from "./i18n/locales";
import { humanizeExpression } from "./strategy-language";

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

/**
 * One indicator line behind the confirmed rules, as the engine computed it.
 *
 * `values` carries no timestamps: it is index-aligned with `bars`, which is what
 * lets the replay advance candles and indicators in one step. `id` is the
 * canonical contract expression, so the label comes from the same renderer that
 * writes the rules on the confirmation step.
 */
export interface BacktestIndicator {
  id: string;
  indicator: string;
  component: string | null;
  timeframe: string;
  /** `"price"` overlays the candles; any other value names a pane of its own. */
  pane: string;
  values: Array<number | null>;
}

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
  indicators: BacktestIndicator[];
  asset: string;
  initialCapital: number;
  locale: Locale;
}

/**
 * Replay pace at 1×, in bars per second. Slow enough to read a signal forming,
 * fast enough that a year of hourly candles does not outlast the reader's
 * patience at 8×.
 */
const BARS_PER_SECOND = 30;
const SPEEDS = [1, 2, 4, 8] as const;
/** Bars kept in frame while the replay runs, so the newest candle is never at the edge. */
const FOLLOW_WINDOW = 160;
/** Beyond this many bars in one step, redrawing the slice costs less than appending it. */
const REDRAW_THRESHOLD = 400;

const PRICE_UP = "#0f7a4d";
const PRICE_DOWN = "#c1362a";
const EQUITY_COLOR = "#1b4fd6";
/**
 * Indicator colours, assigned by position rather than by indicator name: the
 * chart has to stay readable for any combination the grammar allows, and no
 * indicator owns a colour.
 */
const PLOT_COLORS = ["#1b4fd6", "#b6741d", "#7a3fb8", "#0d7d8c", "#a8326f", "#4a5568"];

const PRICE_PANE_HEIGHT = 380;
const INDICATOR_PANE_HEIGHT = 112;
const EQUITY_PANE_HEIGHT = 120;
const TIME_AXIS_HEIGHT = 34;

function chartTime(timestamp: number): Time {
  return Math.floor(timestamp / 1000) as Time;
}

/** Index of the last entry whose sort key is at or before `value`, plus one. */
function countAtOrBefore(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle]! <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

interface ReplayMarker {
  timestamp: number;
  time: Time;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowUp" | "arrowDown" | "circle";
  text: string;
}

/**
 * What the time scale does once the cursor is drawn: track the newest bar while
 * the replay runs, frame the whole run, or leave the reader's own pan and zoom
 * exactly where they put it.
 */
type ViewMode = "follow" | "fit" | "hold";

/** The imperative half of the chart: React owns the cursor, this draws it. */
interface ReplayHandle {
  render(cursor: number, mode: ViewMode): void;
}

export default function BacktestChart({ bars, trades, equityCurve, indicators, asset, initialCapital, locale }: Props) {
  const messages = getMessages(locale);
  const copy = messages.backtest;
  const tag = LOCALE_TAG[locale];
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<ReplayHandle | null>(null);

  // The replay starts fully drawn, so a reader who never presses play sees the
  // whole history exactly as before. A new run remounts this component (the
  // caller keys it by run id), which resets the cursor with it.
  const lastBar = Math.max(0, bars.length - 1);
  const [cursor, setCursor] = useState(lastBar);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const cursorRef = useRef(cursor);

  const money = useCallback(
    (value: number) => new Intl.NumberFormat(tag, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value),
    [tag],
  );
  const barTime = useCallback(
    (value: number) => new Intl.DateTimeFormat(tag, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)),
    [tag],
  );

  /* ------------------------------------------------------------- derived data */

  /**
   * Panes are laid out once per result: price and its overlays first, then one
   * pane per indicator scale in the order the rules referenced them, then the
   * equity curve. Grouping by the server's `pane` key keeps two RSI periods on
   * one axis instead of squeezing in two nearly identical panes.
   */
  const layout = useMemo(() => {
    const paneKeys = [...new Set(indicators.filter((entry) => entry.pane !== "price").map((entry) => entry.pane))];
    const colors = new Map(indicators.map((entry, index) => [entry.id, PLOT_COLORS[index % PLOT_COLORS.length]!]));
    return {
      paneKeys,
      colors,
      equityPane: paneKeys.length + 1,
      height: PRICE_PANE_HEIGHT + INDICATOR_PANE_HEIGHT * paneKeys.length + EQUITY_PANE_HEIGHT + TIME_AXIS_HEIGHT,
    };
  }, [indicators]);

  const markers = useMemo<ReplayMarker[]>(() => {
    const entries = trades.flatMap((trade, index): ReplayMarker[] => [
      {
        timestamp: trade.entryTimestamp,
        time: chartTime(trade.entryTimestamp),
        position: trade.side === "long" ? "belowBar" : "aboveBar",
        color: trade.side === "long" ? PRICE_UP : PRICE_DOWN,
        shape: trade.side === "long" ? "arrowUp" : "arrowDown",
        text: trade.side === "long" ? copy.markerBuy(index + 1) : copy.markerSell(index + 1),
      },
      {
        timestamp: trade.exitTimestamp,
        time: chartTime(trade.exitTimestamp),
        position: trade.side === "long" ? "aboveBar" : "belowBar",
        color: trade.netPnl >= 0 ? PRICE_UP : PRICE_DOWN,
        shape: "circle",
        text: copy.markerExit(`${trade.netPnl >= 0 ? "+" : ""}${trade.netPnl.toFixed(0)}`),
      },
    ]);
    return entries.sort((left, right) => left.timestamp - right.timestamp);
  }, [copy, trades]);

  /**
   * Sorted keys for the three timelines the replay reads at every frame. The
   * equity curve is decimated server-side and the trades are ordered by entry,
   * so neither can be indexed by bar; a binary search over these keeps the
   * per-frame cost flat at the 10,000-bar cap.
   */
  const timeline = useMemo(() => {
    const closed = [...trades].sort((left, right) => left.exitTimestamp - right.exitTimestamp);
    const opened = [...trades].sort((left, right) => left.entryTimestamp - right.entryTimestamp);
    const realized: number[] = [];
    for (const trade of closed) realized.push((realized.at(-1) ?? 0) + trade.netPnl);
    return {
      markerTimes: markers.map((marker) => marker.timestamp),
      equityTimes: equityCurve.map(([timestamp]) => timestamp),
      opened,
      entryTimes: opened.map((trade) => trade.entryTimestamp),
      exitTimes: closed.map((trade) => trade.exitTimestamp),
      realized,
    };
  }, [equityCurve, markers, trades]);

  /** What the account looked like at the replayed bar, read from the run's own records. */
  const state = useMemo(() => {
    const bar = bars[Math.min(cursor, lastBar)];
    if (!bar) return null;
    const timestamp = bar[0];
    const closedCount = countAtOrBefore(timeline.exitTimes, timestamp);
    // The engine holds at most one position, so the newest entry at or before
    // this bar is the only candidate for a position that is still open.
    const entered = countAtOrBefore(timeline.entryTimes, timestamp);
    const latest = entered > 0 ? timeline.opened[entered - 1]! : null;
    const open = latest && latest.exitTimestamp > timestamp ? latest : null;
    const equityIndex = countAtOrBefore(timeline.equityTimes, timestamp) - 1;
    return {
      timestamp,
      close: bar[4],
      side: (open?.side ?? "flat") as "flat" | "long" | "short",
      closedCount,
      realized: closedCount > 0 ? timeline.realized[closedCount - 1]! : 0,
      equity: equityIndex >= 0 ? equityCurve[equityIndex]![1] : initialCapital,
    };
  }, [bars, cursor, equityCurve, initialCapital, lastBar, timeline]);

  /* ------------------------------------------------------------------- chart */

  useEffect(() => {
    const container = containerRef.current;
    if (!container || bars.length === 0) return;
    let disposed = false;
    let cleanup = () => {};

    void import("lightweight-charts").then(({ CandlestickSeries, ColorType, HistogramSeries, LineSeries, createChart, createSeriesMarkers }) => {
      if (disposed) return;
      const chart = createChart(container, {
        width: container.clientWidth,
        height: layout.height,
        layout: {
          background: { type: ColorType.Solid, color: "#ffffff" },
          textColor: "#6f7889",
          panes: { separatorColor: "#e2e5ec", separatorHoverColor: EQUITY_COLOR, enableResize: true },
        },
        grid: { vertLines: { color: "#eef0f4" }, horzLines: { color: "#eef0f4" } },
        crosshair: { vertLine: { color: "#9aa2b1", labelBackgroundColor: EQUITY_COLOR }, horzLine: { color: "#9aa2b1", labelBackgroundColor: EQUITY_COLOR } },
        rightPriceScale: { borderColor: "#e2e5ec" },
        timeScale: { borderColor: "#e2e5ec", timeVisible: true, secondsVisible: false, rightOffset: 5 },
        localization: { locale: tag },
      });

      const candles = chart.addSeries(CandlestickSeries, {
        upColor: PRICE_UP,
        downColor: PRICE_DOWN,
        borderUpColor: PRICE_UP,
        borderDownColor: PRICE_DOWN,
        wickUpColor: "#3f9b71",
        wickDownColor: "#cf6255",
        priceLineVisible: true,
      }, 0);

      /**
       * Every series exposes the same two moves so the replay does not care what
       * it is drawing: append the next bar when moving forward, or redraw the
       * revealed slice when the reader scrubs backwards.
       */
      const renderers: Array<{ push(index: number): void; reset(count: number): void }> = [];
      const candlePoint = (index: number) => {
        const [timestamp, open, high, low, close] = bars[index]!;
        return { time: chartTime(timestamp), open, high, low, close };
      };
      renderers.push({
        push: (index) => candles.update(candlePoint(index)),
        reset: (count) => candles.setData(Array.from({ length: count }, (_, index) => candlePoint(index))),
      });

      for (const plot of indicators) {
        const color = layout.colors.get(plot.id)!;
        const paneIndex = plot.pane === "price" ? 0 : layout.paneKeys.indexOf(plot.pane) + 1;
        // A histogram reads the MACD divergence far better than a line does, and
        // it is the only component of the grammar that is a bar rather than a level.
        const isHistogram = plot.component === "histogram";
        const point = (index: number) => {
          const value = plot.values[index];
          if (value === null || value === undefined) return { time: chartTime(bars[index]![0]) };
          return isHistogram
            ? { time: chartTime(bars[index]![0]), value, color: value >= 0 ? PRICE_UP : PRICE_DOWN }
            : { time: chartTime(bars[index]![0]), value };
        };
        const series = isHistogram
          ? chart.addSeries(HistogramSeries, { color, priceLineVisible: false, lastValueVisible: false }, paneIndex)
          : chart.addSeries(LineSeries, {
            color,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: true,
            title: humanizeExpression(messages, plot.id),
          }, paneIndex);
        renderers.push({
          push: (index) => series.update(point(index)),
          reset: (count) => series.setData(Array.from({ length: count }, (_, index) => point(index))),
        });
      }

      const equity = chart.addSeries(LineSeries, {
        color: EQUITY_COLOR,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        title: copy.legendEquity,
      }, layout.equityPane);

      const seriesMarkers = createSeriesMarkers(candles, []);

      /* --------------------------------------------------------- replay state */

      let rendered = -1;
      let equityRendered = 0;
      let markersRendered = -1;
      const equityPoint = (index: number) => {
        const [timestamp, value] = equityCurve[index]!;
        return { time: chartTime(timestamp), value };
      };

      const follow = (target: number) => {
        const span = Math.min(FOLLOW_WINDOW, bars.length);
        chart.timeScale().setVisibleLogicalRange({ from: target - span + 1, to: target + Math.round(span * 0.08) });
      };

      const render = (cursorValue: number, mode: ViewMode) => {
        const target = Math.max(0, Math.min(cursorValue, bars.length - 1));
        if (target !== rendered) {
          const equityTarget = countAtOrBefore(timeline.equityTimes, bars[target]![0]);
          // Appending is what keeps a playing replay cheap, but it is the wrong
          // tool for the first draw and for a scrub across thousands of bars,
          // where one `setData` beats a point at a time.
          if (rendered < 0 || target < rendered || target - rendered > REDRAW_THRESHOLD) {
            for (const renderer of renderers) renderer.reset(target + 1);
            equity.setData(Array.from({ length: equityTarget }, (_, index) => equityPoint(index)));
          } else {
            for (let index = rendered + 1; index <= target; index += 1) {
              for (const renderer of renderers) renderer.push(index);
            }
            for (let index = equityRendered; index < equityTarget; index += 1) equity.update(equityPoint(index));
          }
          equityRendered = equityTarget;
          rendered = target;
          const visible = countAtOrBefore(timeline.markerTimes, bars[target]![0]);
          if (visible !== markersRendered) {
            seriesMarkers.setMarkers(markers.slice(0, visible));
            markersRendered = visible;
          }
        }
        if (mode === "follow") follow(target);
        else if (mode === "fit") chart.timeScale().fitContent();
      };

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

      const panes = chart.panes();
      panes[0]?.setHeight(PRICE_PANE_HEIGHT);
      for (let index = 1; index <= layout.paneKeys.length; index += 1) panes[index]?.setHeight(INDICATOR_PANE_HEIGHT);
      panes[layout.equityPane]?.setHeight(EQUITY_PANE_HEIGHT);

      // The chart mounts at whatever the cursor already is — the whole run on a
      // first render, or mid-replay when a re-mount interrupts one.
      render(cursorRef.current, cursorRef.current >= bars.length - 1 ? "fit" : "follow");
      handleRef.current = { render };

      const observer = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth }));
      observer.observe(container);
      cleanup = () => {
        handleRef.current = null;
        observer.disconnect();
        chart.remove();
      };
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [asset, bars, copy.legendEquity, equityCurve, indicators, layout, markers, messages, tag, timeline]);

  /* ---------------------------------------------------------------- playback */

  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  // A playing replay tracks the newest bar; a paused one leaves the reader's own
  // pan and zoom untouched. Framing the whole run is only ever an explicit ask.
  useEffect(() => {
    handleRef.current?.render(cursor, playing ? "follow" : "hold");
  }, [cursor, playing]);

  useEffect(() => {
    if (!playing || bars.length === 0) return;
    let frame = 0;
    let previous = performance.now();
    const step = (now: number) => {
      const advance = Math.floor((now - previous) / 1000 * BARS_PER_SECOND * speed);
      if (advance >= 1) {
        previous = now;
        const next = Math.min(bars.length - 1, cursorRef.current + advance);
        cursorRef.current = next;
        setCursor(next);
        if (next >= bars.length - 1) {
          setPlaying(false);
          return;
        }
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [bars.length, playing, speed]);

  function togglePlay() {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (cursorRef.current >= lastBar) {
      cursorRef.current = 0;
      setCursor(0);
    }
    setPlaying(true);
  }

  function seek(value: number) {
    setPlaying(false);
    cursorRef.current = value;
    setCursor(value);
  }

  /**
   * Reveals the whole run and frames it. The chart is told directly rather than
   * through the cursor effect, which would not fire when the replay has already
   * reached the end and left the view zoomed on its last bars.
   */
  function showAll() {
    seek(lastBar);
    handleRef.current?.render(lastBar, "fit");
  }

  /* ------------------------------------------------------------------ render */

  const atEnd = cursor >= lastBar;

  return (
    <div className="chart-shell">
      <div className="replay-bar">
        <div className="replay-controls">
          <button className="replay-play" onClick={togglePlay} aria-label={playing ? copy.replayPause : copy.replayPlay}>
            <b aria-hidden="true">{playing ? "❚❚" : "▶"}</b>
            <span>{playing ? copy.replayPause : atEnd ? copy.replayRestart : copy.replayPlay}</span>
          </button>
          <button className="replay-step" onClick={showAll}>{copy.replayShowAll}</button>
          <div className="replay-speed" role="group" aria-label={copy.replaySpeed}>
            {SPEEDS.map((option) => (
              <button key={option} className={speed === option ? "active" : ""} onClick={() => setSpeed(option)}>{option}×</button>
            ))}
          </div>
        </div>
        <input
          className="replay-scrub"
          type="range"
          min={0}
          max={lastBar}
          value={Math.min(cursor, lastBar)}
          aria-label={copy.replayScrub}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <span className="replay-progress">{copy.replayProgress(Math.min(cursor + 1, bars.length), bars.length)}</span>
      </div>

      {state && (
        <div className="replay-state" role="status" aria-live="off">
          <article><span>{copy.replayBarLabel}</span><strong>{barTime(state.timestamp)}</strong></article>
          <article><span>{copy.replayPriceLabel}</span><strong>{state.close.toFixed(2)}</strong></article>
          <article className={`position-${state.side}`}><span>{copy.replayPositionLabel}</span><strong>{copy.replayPositions[state.side]}</strong></article>
          <article><span>{copy.replayEquityLabel}</span><strong>{money(state.equity)}</strong></article>
          <article className={state.realized >= 0 ? "positive" : "negative"}>
            <span>{copy.replayTradesLabel}</span>
            <strong>{copy.replayTradesValue(state.closedCount, money(state.realized))}</strong>
          </article>
        </div>
      )}

      <div className="chart-legend">
        <span><i style={{ background: PRICE_UP }} />{copy.legendEntryLong}</span>
        <span><i style={{ background: PRICE_DOWN }} />{copy.legendEntryShort}</span>
        <span><i className="exit-dot" />{copy.legendExit}</span>
        <span><i style={{ background: EQUITY_COLOR }} />{copy.legendEquity}</span>
        {indicators.map((plot) => (
          <span key={plot.id}><i style={{ background: layout.colors.get(plot.id) }} />{humanizeExpression(messages, plot.id)}</span>
        ))}
      </div>

      <div ref={containerRef} className="backtest-chart" style={{ height: layout.height }} aria-label={copy.chartAria(asset)} />
      <div ref={tooltipRef} className="chart-tooltip" hidden />
      {indicators.length === 0 && <p className="chart-note">{copy.noIndicators}</p>}
    </div>
  );
}
