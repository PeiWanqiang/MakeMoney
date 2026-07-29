import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { emaTrendStrategy } from "../examples/strategies.js";
import type { BacktestConfig, MarketBar } from "../src/core/types.js";
import { runBacktest } from "../src/runtime/backtest.js";

const execFileAsync = promisify(execFile);

describe("independent Python reference backtest", () => {
  it("matches the TypeScript engine on a deterministic EMA scenario", async () => {
    const config: BacktestConfig = { initialCapital: 10_000, takerFeeRate: 0.00045, slippageBps: 2, maxLeverage: 3 };
    const bars: MarketBar[] = Array.from({ length: 240 }, (_, index) => {
      const close = 100 + index * 0.03 + Math.sin(index / 6) * 12;
      const previousClose = index === 0 ? close : 100 + (index - 1) * 0.03 + Math.sin((index - 1) / 6) * 12;
      return {
        timestamp: Date.UTC(2024, 0, 1) + index * 4 * 60 * 60 * 1_000,
        open: previousClose,
        high: Math.max(previousClose, close) + 1,
        low: Math.min(previousClose, close) - 1,
        close,
        volume: 1_000,
        markPrice: close,
        fundingRate: 0,
      };
    });
    const authoritative = await runBacktest(emaTrendStrategy, bars, config);
    const directory = await mkdtemp(join(tmpdir(), "python-reference-test-"));
    try {
      const input = join(directory, "fixture.json");
      const output = join(directory, "result.json");
      await writeFile(
        input,
        JSON.stringify({
          schemaVersion: "1.0",
          config,
          strategy: { kind: "ema-trend", fastPeriod: 20, slowPeriod: 50, riskPercent: 0.01, stopLossPercent: 0.05 },
          bars,
        }),
        "utf8",
      );
      await execFileAsync("python3", [resolve("reference/python_reference_backtest.py"), input, output]);
      const reference = JSON.parse(await readFile(output, "utf8")) as {
        finalEquity: number;
        returnPercent: number;
        trades: unknown[];
        equityCurve: Array<{ equity: number }>;
      };
      expect(authoritative.trades.length).toBeGreaterThan(0);
      expect(reference.trades).toHaveLength(authoritative.trades.length);
      expect(reference.finalEquity).toBe(authoritative.finalEquity);
      expect(reference.returnPercent).toBe(authoritative.returnPercent);
      expect(reference.equityCurve.map((point) => point.equity)).toEqual(
        authoritative.equityCurve.map((point) => point.equity),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
