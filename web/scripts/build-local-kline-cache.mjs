import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { strFromU8, unzipSync } from "fflate";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";

const project = resolve(import.meta.dirname, "..");
const workspace = resolve(project, "..");
const outputRoot = resolve(project, "public/prooftrade-data/klines");
const sources = [
  {
    catalog: resolve(workspace, "data/history/binance-usdm/BTCUSDT-PERP/1m/dataset.catalog.json"),
    market: "perpetual",
    asset: "BTCUSDT",
    intervals: ["1h", "4h"],
    intervalFromMonth: { "15m": "2025-07" },
  },
  {
    catalog: resolve(workspace, "data/history/binance-spot/BTCUSDT/1m/dataset.catalog.json"),
    market: "spot",
    asset: "BTCUSDT",
    intervals: ["15m", "1h", "4h"],
    intervalFromMonth: {},
  },
];
const intervalMs = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 };

function number(row, key) {
  const value = Number(row[key]);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${key} in local dataset`);
  return value;
}

function aggregate(rows, timeframe) {
  const width = intervalMs[timeframe];
  const groups = new Map();
  for (const row of rows) {
    const timestamp = Math.floor(number(row, "timestamp") / width) * width;
    const current = groups.get(timestamp);
    if (!current) {
      groups.set(timestamp, [timestamp, number(row, "open"), number(row, "high"), number(row, "low"), number(row, "close"), number(row, "volume"), 1]);
    } else {
      current[2] = Math.max(current[2], number(row, "high"));
      current[3] = Math.min(current[3], number(row, "low"));
      current[4] = number(row, "close");
      current[5] += number(row, "volume");
      current[6] += 1;
    }
  }
  const expected = width / 60_000;
  return [...groups.values()].filter((row) => row[6] === expected).map((row) => row.slice(0, 6));
}

function compactRawRows(rows) {
  return rows.flatMap((row) => {
    if (!Array.isArray(row) || row.length < 6) return [];
    const bar = row.slice(0, 6).map(Number);
    if (!bar.every(Number.isFinite)) return [];
    if (bar[0] > 100_000_000_000_000) bar[0] = Math.floor(bar[0] / 1000);
    return [bar];
  });
}

async function writeCompactMonth(market, asset, timeframe, month, bars) {
  const output = resolve(outputRoot, market, asset, timeframe, `${month}.json.gz`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, gzipSync(JSON.stringify(bars), { level: 9 }));
}

const manifest = { schemaVersion: "1", generatorVersion: "local-kline-cache-v1", sources: [] };
for (const source of sources) {
  const catalog = JSON.parse(await readFile(source.catalog, "utf8"));
  const emitted = {};
  for (const partition of catalog.partitions) {
    const file = await asyncBufferFromFile(resolve(dirname(source.catalog), partition.dataFile));
    const rows = await parquetReadObjects({ file });
    const intervals = [
      ...source.intervals,
      ...Object.entries(source.intervalFromMonth).filter(([, month]) => partition.month >= month).map(([timeframe]) => timeframe),
    ];
    for (const timeframe of [...new Set(intervals)]) {
      const bars = aggregate(rows, timeframe);
      const output = resolve(outputRoot, source.market, source.asset, timeframe, `${partition.month}.json.gz`);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, gzipSync(JSON.stringify(bars), { level: 9 }));
      emitted[timeframe] = (emitted[timeframe] ?? 0) + bars.length;
    }
  }
  manifest.sources.push({
    market: source.market,
    asset: source.asset,
    datasetId: catalog.datasetId,
    actualStart: catalog.actualStart,
    actualEnd: catalog.actualEnd,
    source: catalog.source,
    emitted,
  });
}

const now = new Date();
const currentMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
const currentMonthKey = new Date(currentMonth).toISOString().slice(0, 7);
const completedDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1);
const recentMinuteBars = [];
for (let day = currentMonth; day <= completedDay; day += 86_400_000) {
  const date = new Date(day).toISOString().slice(0, 10);
  const url = `https://data.binance.vision/data/futures/um/daily/klines/BTCUSDT/1m/BTCUSDT-1m-${date}.zip`;
  const response = await fetch(url);
  if (response.status === 404) continue;
  if (!response.ok) throw new Error(`Recent local seed failed with HTTP ${response.status}: ${url}`);
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const csv = Object.entries(files).find(([name]) => name.endsWith(".csv"))?.[1];
  if (!csv) throw new Error(`Recent local seed is missing CSV: ${url}`);
  recentMinuteBars.push(...compactRawRows(strFromU8(csv).split(/\r?\n/).map((line) => line.split(","))));
}
if (recentMinuteBars.length > 0) {
  await writeCompactMonth("perpetual", "BTCUSDT", "1m", currentMonthKey, recentMinuteBars);
  for (const timeframe of ["15m", "1h", "4h"]) {
    const rows = recentMinuteBars.map(([timestamp, open, high, low, close, volume]) => ({ timestamp, open, high, low, close, volume }));
    await writeCompactMonth("perpetual", "BTCUSDT", timeframe, currentMonthKey, aggregate(rows, timeframe));
  }
  manifest.recentSeed = {
    market: "perpetual",
    asset: "BTCUSDT",
    month: currentMonthKey,
    actualStart: recentMinuteBars[0][0],
    actualEnd: recentMinuteBars.at(-1)[0] + 59_999,
    minuteBars: recentMinuteBars.length,
  };
}
await mkdir(outputRoot, { recursive: true });
await writeFile(resolve(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify(manifest, null, 2));
