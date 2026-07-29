import { readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  ensureDownload,
  findVerifiedPartition,
  forEachZipLine,
  parseBinanceFundingRate,
  parseBinanceKline,
  parseUtcDate,
  utcMonths,
  writeDatasetCatalog,
  writeHistoricalPartition,
  zipEntries,
  type HistoricalPartition,
} from "../src/data/historical-dataset.js";
import type { NormalizedMarketBar } from "../src/data/hyperliquid-client.js";
import { sha256File } from "../src/data/market-snapshot.js";

interface OfficialArchive {
  kind: "klines" | "markPriceKlines" | "fundingRate";
  url: string;
  path: string;
  file: string;
  sha256: string;
  entry: string;
}

function parseArgs(args: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Arguments must use --name value pairs.");
    parsed.set(key.slice(2), value);
  }
  return parsed;
}

function firstDayOfCurrentUtcMonth(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function assertMonthBoundary(timestamp: number, name: string): void {
  const value = new Date(timestamp);
  if (
    value.getUTCDate() !== 1 ||
    value.getUTCHours() !== 0 ||
    value.getUTCMinutes() !== 0 ||
    value.getUTCSeconds() !== 0 ||
    value.getUTCMilliseconds() !== 0
  ) {
    throw new Error(`${name} must be the first UTC instant of a month.`);
  }
}

async function officialArchive(
  kind: OfficialArchive["kind"],
  symbol: string,
  month: string,
  cache: string,
): Promise<OfficialArchive> {
  const intervalPath = kind === "fundingRate" ? "" : "/1m";
  const file = kind === "fundingRate" ? `${symbol}-fundingRate-${month}.zip` : `${symbol}-1m-${month}.zip`;
  const baseUrl = `https://data.binance.vision/data/futures/um/monthly/${kind}/${symbol}${intervalPath}`;
  const url = `${baseUrl}/${file}`;
  const directory = join(cache, kind);
  const path = join(directory, file);
  const checksumPath = `${path}.CHECKSUM`;
  await Promise.all([ensureDownload(url, path), ensureDownload(`${url}.CHECKSUM`, checksumPath)]);
  const expected = (await readFile(checksumPath, "utf8")).match(/[a-fA-F0-9]{64}/)?.[0]?.toLowerCase();
  if (!expected) throw new Error(`Official checksum is malformed: ${checksumPath}`);
  let actual = await sha256File(path);
  if (actual !== expected) {
    await unlink(path);
    await ensureDownload(url, path);
    actual = await sha256File(path);
  }
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${file}.`);
  const csvSuffix = file.replace(/\.zip$/, ".csv");
  const entry = (await zipEntries(path)).find((candidate) => candidate.endsWith(csvSuffix));
  if (!entry) throw new Error(`${file} does not contain ${csvSuffix}.`);
  return { kind, url, path, file, sha256: actual, entry };
}

const args = parseArgs(process.argv.slice(2));
const symbol = (args.get("symbol") ?? "BTCUSDT").toUpperCase();
if (!/^[A-Z0-9]{4,24}$/.test(symbol)) throw new Error("--symbol contains unsupported characters.");
const start = parseUtcDate(args.get("start") ?? "2020-01-01T00:00:00Z");
const end = parseUtcDate(args.get("end") ?? new Date(firstDayOfCurrentUtcMonth()).toISOString());
assertMonthBoundary(start, "--start");
assertMonthBoundary(end, "--end");
if (start >= end) throw new Error("--start must be earlier than --end; --end is exclusive.");
if (end > firstDayOfCurrentUtcMonth()) {
  throw new Error("Monthly archives can only be downloaded through the last completed UTC month.");
}

const output = resolve(args.get("output") ?? `data/history/binance-usdm/${symbol}-PERP/1m`);
const cache = resolve(args.get("cache") ?? `data/cache/binance-vision/futures-um/${symbol}`);
const partitions: HistoricalPartition[] = [];

for (const month of utcMonths(start, end)) {
  const existing = await findVerifiedPartition(output, month);
  if (existing) {
    console.log(`[${month}] verified perpetual partition exists; skipping.`);
    partitions.push(existing);
    continue;
  }

  console.log(`[${month}] downloading trade, mark-price and funding archives...`);
  const [tradeArchive, markArchive, fundingArchive] = await Promise.all([
    officialArchive("klines", symbol, month, cache),
    officialArchive("markPriceKlines", symbol, month, cache),
    officialArchive("fundingRate", symbol, month, cache),
  ]);

  const markPrices = new Map<number, number>();
  await forEachZipLine(markArchive.path, markArchive.entry, (line) => {
    const mark = parseBinanceKline(line);
    if (mark) markPrices.set(mark.timestamp, mark.close);
  });

  const fundingRates = new Map<number, number>();
  await forEachZipLine(fundingArchive.path, fundingArchive.entry, (line) => {
    const event = parseBinanceFundingRate(line);
    if (event) fundingRates.set(event.timestamp, (fundingRates.get(event.timestamp) ?? 0) + event.rate);
  });

  const monthStart = Date.parse(`${month}-01T00:00:00Z`);
  const nextMonth = new Date(monthStart);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const bars: NormalizedMarketBar[] = [];
  let missingMarkPrices = 0;
  await forEachZipLine(tradeArchive.path, tradeArchive.entry, (line) => {
    const trade = parseBinanceKline(line);
    if (!trade || trade.timestamp < start || trade.timestamp >= end) return;
    const markPrice = markPrices.get(trade.timestamp);
    if (markPrice === undefined) missingMarkPrices += 1;
    bars.push({
      ...trade,
      fundingRate: fundingRates.get(trade.timestamp) ?? 0,
      ...(markPrice === undefined ? {} : { markPrice }),
    });
  });

  console.log(
    `[${month}] ${bars.length.toLocaleString("en-US")} candles, ${markPrices.size.toLocaleString("en-US")} marks, ${fundingRates.size} funding events; writing Parquet...`,
  );
  partitions.push(
    await writeHistoricalPartition(
      {
        month,
        coin: symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol,
        requestedStart: monthStart,
        requestedEnd: nextMonth.getTime() - 1,
        bars,
        fundingEvents: fundingRates.size,
        missingMarkPrices,
        identity: {
          source: "binance-vision",
          venue: "binance-usdm",
          instrument: `${symbol}-PERP`,
          filePrefix: `binance-usdm-${symbol.toLowerCase()}-perp`,
          provenance: {
            archives: [tradeArchive, markArchive, fundingArchive].map((archive) => ({
              kind: archive.kind,
              url: archive.url,
              file: archive.file,
              sha256: archive.sha256,
            })),
          },
        },
      },
      output,
    ),
  );
}

const catalogPath = await writeDatasetCatalog(
  output,
  {
    source: "binance-vision",
    venue: "binance-usdm",
    instrument: `${symbol}-PERP`,
    requestedStart: start,
    requestedEnd: end,
  },
  partitions,
);
console.log(`Perpetual dataset ready: ${catalogPath}`);
console.log(`Rows: ${partitions.reduce((sum, partition) => sum + partition.rowCount, 0).toLocaleString("en-US")}`);
