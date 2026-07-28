import { readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  ensureDownload,
  findVerifiedPartition,
  forEachZipLine,
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

const args = parseArgs(process.argv.slice(2));
const symbol = (args.get("symbol") ?? "BTCUSDT").toUpperCase();
if (!/^[A-Z0-9]{4,24}$/.test(symbol)) throw new Error("--symbol contains unsupported characters.");
const start = parseUtcDate(args.get("start") ?? "2024-01-01T00:00:00Z");
const end = parseUtcDate(args.get("end") ?? "2025-01-01T00:00:00Z");
if (start >= end) throw new Error("--start must be earlier than --end; --end is exclusive.");
const output = resolve(args.get("output") ?? `data/history/binance-spot/${symbol}/1m`);
const cache = resolve(args.get("cache") ?? `data/cache/binance-vision/${symbol}/1m`);
const partitions: HistoricalPartition[] = [];

for (const month of utcMonths(start, end)) {
  const existing = await findVerifiedPartition(output, month);
  if (existing) {
    console.log(`[${month}] verified partition exists; skipping download.`);
    partitions.push(existing);
    continue;
  }

  const archiveName = `${symbol}-1m-${month}.zip`;
  const baseUrl = `https://data.binance.vision/data/spot/monthly/klines/${symbol}/1m`;
  const archiveUrl = `${baseUrl}/${archiveName}`;
  const archivePath = join(cache, archiveName);
  const checksumPath = join(cache, `${archiveName}.CHECKSUM`);
  console.log(`[${month}] downloading official archive and checksum...`);
  await Promise.all([
    ensureDownload(archiveUrl, archivePath),
    ensureDownload(`${archiveUrl}.CHECKSUM`, checksumPath),
  ]);

  const expectedHash = (await readFile(checksumPath, "utf8")).match(/[a-fA-F0-9]{64}/)?.[0]?.toLowerCase();
  if (!expectedHash) throw new Error(`Official checksum is malformed: ${checksumPath}`);
  let archiveHash = await sha256File(archivePath);
  if (archiveHash !== expectedHash) {
    await unlink(archivePath);
    await ensureDownload(archiveUrl, archivePath);
    archiveHash = await sha256File(archivePath);
  }
  if (archiveHash !== expectedHash) throw new Error(`SHA-256 mismatch for ${archiveName}.`);

  const entries = await zipEntries(archivePath);
  const entry = entries.find((candidate) => candidate.endsWith(archiveName.replace(/\.zip$/, ".csv")));
  if (!entry) throw new Error(`Archive ${archiveName} does not contain the expected 1m CSV.`);
  const monthStart = Date.parse(`${month}-01T00:00:00Z`);
  const nextMonth = new Date(monthStart);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const partitionStart = Math.max(start, monthStart);
  const partitionEnd = Math.min(end, nextMonth.getTime());
  const bars: NormalizedMarketBar[] = [];
  await forEachZipLine(archivePath, entry, (line) => {
    const bar = parseBinanceKline(line);
    if (bar && bar.timestamp >= partitionStart && bar.timestamp < partitionEnd) bars.push(bar);
  });
  console.log(`[${month}] parsed ${bars.length.toLocaleString("en-US")} candles; writing Parquet...`);
  partitions.push(
    await writeHistoricalPartition(
      {
        month,
        coin: symbol.slice(0, -4),
        requestedStart: partitionStart,
        requestedEnd: partitionEnd - 1,
        bars,
        identity: {
          source: "binance-vision",
          venue: "binance-spot",
          instrument: symbol,
          filePrefix: `binance-spot-${symbol.toLowerCase()}`,
          provenance: { url: archiveUrl, archiveFile: archiveName, archiveSha256: archiveHash },
        },
      },
      output,
    ),
  );
}

const catalogPath = await writeDatasetCatalog(
  output,
  { source: "binance-vision", venue: "binance-spot", instrument: symbol, requestedStart: start, requestedEnd: end },
  partitions,
);
console.log(`Dataset ready: ${catalogPath}`);
console.log(`Rows: ${partitions.reduce((sum, partition) => sum + partition.rowCount, 0).toLocaleString("en-US")}`);
