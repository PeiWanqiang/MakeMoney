import { resolve } from "node:path";

import {
  archiveBasename,
  ensureDownload,
  findVerifiedPartition,
  forEachZipLine,
  monthKey,
  parseKrakenKline,
  parseUtcDate,
  writeDatasetCatalog,
  writeHistoricalPartition,
  zipEntries,
  type HistoricalPartition,
} from "../src/data/historical-dataset.js";
import type { NormalizedMarketBar } from "../src/data/hyperliquid-client.js";
import { sha256File } from "../src/data/market-snapshot.js";

const KRAKEN_COMPLETE_ARCHIVE_URL =
  "https://drive.usercontent.google.com/download?id=1ptNqWYidLkhb2VAKuLCxmp2OXEfGO-AP&export=download&confirm=t";

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
const pair = (args.get("pair") ?? "XBTUSD").toUpperCase();
if (!/^[A-Z0-9]{4,24}$/.test(pair)) throw new Error("--pair contains unsupported characters.");
const start = parseUtcDate(args.get("start") ?? "2016-01-01T00:00:00Z");
const end = parseUtcDate(args.get("end") ?? "2026-01-01T00:00:00Z");
if (start >= end) throw new Error("--start must be earlier than --end; --end is exclusive.");
const output = resolve(args.get("output") ?? `data/history/kraken-spot/${pair}/1m`);
const archivePath = resolve(args.get("archive") ?? "data/cache/kraken/Kraken_OHLCVT.zip");

if (!args.has("archive")) {
  console.log("Downloading Kraken's official complete OHLCVT archive (resumable)...");
  console.log("If Google Drive blocks automated download, download the official ZIP in a browser and pass --archive /absolute/path/Kraken_OHLCVT.zip.");
  await ensureDownload(KRAKEN_COMPLETE_ARCHIVE_URL, archivePath);
}

const entries = await zipEntries(archivePath);
const expectedSuffix = `${pair}_1.csv`.toLowerCase();
const entry = entries.find((candidate) => candidate.toLowerCase().endsWith(expectedSuffix));
if (!entry) {
  throw new Error(`The archive does not contain ${pair}_1.csv. Available 1m pair names can be inspected with: unzip -Z1 '${archivePath}'`);
}
const archiveHash = await sha256File(archivePath);
const partitions: HistoricalPartition[] = [];
const verified = new Map<string, HistoricalPartition>();
for (let cursor = new Date(start); cursor.getTime() < end; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
  const month = monthKey(cursor.getTime());
  const existing = await findVerifiedPartition(output, month);
  if (existing) verified.set(month, existing);
}

let activeMonth: string | undefined;
let activeBars: NormalizedMarketBar[] = [];

async function flush(): Promise<void> {
  if (!activeMonth || activeBars.length === 0) return;
  const existing = verified.get(activeMonth);
  if (existing) {
    console.log(`[${activeMonth}] verified partition exists; skipping write.`);
    partitions.push(existing);
    activeBars = [];
    return;
  }
  const monthStart = Date.parse(`${activeMonth}-01T00:00:00Z`);
  const nextMonth = new Date(monthStart);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  console.log(`[${activeMonth}] writing ${activeBars.length.toLocaleString("en-US")} Kraken candles to Parquet...`);
  partitions.push(
    await writeHistoricalPartition(
      {
        month: activeMonth,
        coin: "BTC",
        requestedStart: Math.max(start, monthStart),
        requestedEnd: Math.min(end, nextMonth.getTime()) - 1,
        bars: activeBars,
        identity: {
          source: "kraken-ohlcvt",
          venue: "kraken-spot",
          instrument: pair,
          filePrefix: `kraken-spot-${pair.toLowerCase()}`,
          provenance: {
            url: "https://support.kraken.com/articles/360047124832-downloadable-historical-ohlcvt-open-high-low-close-volume-trades-data",
            archiveFile: archiveBasename(archivePath),
            archiveSha256: archiveHash,
          },
        },
      },
      output,
    ),
  );
  activeBars = [];
}

console.log(`Streaming ${entry} from ${archiveBasename(archivePath)}...`);
await forEachZipLine(archivePath, entry, async (line) => {
  const bar = parseKrakenKline(line);
  if (!bar || bar.timestamp < start || bar.timestamp >= end) return;
  const month = monthKey(bar.timestamp);
  if (activeMonth && month !== activeMonth) await flush();
  activeMonth = month;
  activeBars.push(bar);
});
await flush();

const catalogPath = await writeDatasetCatalog(
  output,
  { source: "kraken-ohlcvt", venue: "kraken-spot", instrument: pair, requestedStart: start, requestedEnd: end },
  partitions,
);
console.log(`Dataset ready: ${catalogPath}`);
console.log(`Rows: ${partitions.reduce((sum, partition) => sum + partition.rowCount, 0).toLocaleString("en-US")}`);
