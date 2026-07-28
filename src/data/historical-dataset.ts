import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { DownloadedMarketData, MarketDataQuality, NormalizedMarketBar } from "./hyperliquid-client.js";
import { ONE_MINUTE_MS } from "./hyperliquid-client.js";
import {
  loadMarketSnapshot,
  sha256File,
  writeMarketSnapshot,
  type MarketSnapshotIdentity,
  type MarketSnapshotManifest,
} from "./market-snapshot.js";
import type { MarketBar } from "../core/types.js";

export interface HistoricalPartition {
  month: string;
  manifestFile: string;
  dataFile: string;
  rowCount: number;
  actualStart: number;
  actualEnd: number;
  dataSha256: string;
  gaps: number;
}

export interface HistoricalDatasetCatalog {
  schemaVersion: "1.0";
  datasetId: string;
  createdAt: string;
  source: MarketSnapshotManifest["source"];
  venue: MarketSnapshotManifest["venue"];
  instrument: string;
  interval: "1m";
  requestedStart: number;
  requestedEnd: number;
  actualStart: number;
  actualEnd: number;
  rowCount: number;
  expectedMinutes: number;
  observedMissingMinutes: number;
  partitions: HistoricalPartition[];
}

export interface PartitionInput {
  month: string;
  coin: string;
  requestedStart: number;
  requestedEnd: number;
  bars: NormalizedMarketBar[];
  identity: MarketSnapshotIdentity;
}

export function parseUtcDate(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid date '${value}'. Use an ISO-8601 date in UTC.`);
  return timestamp;
}

export function monthKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

export function utcMonths(start: number, endExclusive: number): string[] {
  const months: string[] = [];
  const cursor = new Date(start);
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() < endExclusive) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function timestampMilliseconds(raw: string, unit: "seconds" | "milliseconds-or-microseconds"): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid candle timestamp '${raw}'.`);
  if (unit === "seconds") return Math.trunc(value * 1_000);
  return Math.trunc(value > 100_000_000_000_000 ? value / 1_000 : value);
}

function finite(raw: string | undefined, field: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${field} '${raw ?? ""}'.`);
  return value;
}

export function parseBinanceKline(line: string): NormalizedMarketBar | undefined {
  const columns = line.trim().split(",");
  if (!/^\d+$/.test(columns[0] ?? "")) return undefined;
  const timestamp = timestampMilliseconds(columns[0] ?? "", "milliseconds-or-microseconds");
  const open = finite(columns[1], "open");
  const high = finite(columns[2], "high");
  const low = finite(columns[3], "low");
  const close = finite(columns[4], "close");
  const volume = finite(columns[5], "volume");
  const trades = Math.trunc(finite(columns[8], "trades"));
  return { timestamp, endTimestamp: timestamp + ONE_MINUTE_MS - 1, open, high, low, close, volume, trades, fundingRate: 0, fundingPremium: 0 };
}

export function parseKrakenKline(line: string): NormalizedMarketBar | undefined {
  const columns = line.trim().split(",");
  if (!/^\d+$/.test(columns[0] ?? "")) return undefined;
  const timestamp = timestampMilliseconds(columns[0] ?? "", "seconds");
  const open = finite(columns[1], "open");
  const high = finite(columns[2], "high");
  const low = finite(columns[3], "low");
  const close = finite(columns[4], "close");
  const volume = finite(columns[5], "volume");
  const trades = Math.trunc(finite(columns[6], "trades"));
  return { timestamp, endTimestamp: timestamp + ONE_MINUTE_MS - 1, open, high, low, close, volume, trades, fundingRate: 0, fundingPremium: 0 };
}

function validateBars(bars: NormalizedMarketBar[]): { bars: NormalizedMarketBar[]; quality: MarketDataQuality } {
  const unique = new Map<number, NormalizedMarketBar>();
  let duplicateCandles = 0;
  let invalidCandles = 0;
  for (const bar of bars) {
    if (
      bar.timestamp % ONE_MINUTE_MS !== 0 ||
      ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
      bar.high < Math.max(bar.open, bar.close) ||
      bar.low > Math.min(bar.open, bar.close) ||
      bar.low > bar.high ||
      bar.volume < 0 ||
      bar.trades < 0
    ) {
      invalidCandles += 1;
      continue;
    }
    if (unique.has(bar.timestamp)) duplicateCandles += 1;
    unique.set(bar.timestamp, bar);
  }
  const sorted = [...unique.values()].sort((left, right) => left.timestamp - right.timestamp);
  const gaps: MarketDataQuality["gaps"] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (!previous || !current || current.timestamp === previous.timestamp + ONE_MINUTE_MS) continue;
    gaps.push({
      afterTimestamp: previous.timestamp,
      expectedTimestamp: previous.timestamp + ONE_MINUTE_MS,
      actualTimestamp: current.timestamp,
      missingBars: Math.max(0, (current.timestamp - previous.timestamp) / ONE_MINUTE_MS - 1),
    });
  }
  return { bars: sorted, quality: { duplicateCandles, invalidCandles, gaps, fundingEvents: 0 } };
}

export async function writeHistoricalPartition(input: PartitionInput, outputDirectory: string): Promise<HistoricalPartition> {
  const validated = validateBars(input.bars);
  if (validated.bars.length === 0) throw new Error(`Partition ${input.month} contains no valid candles.`);
  const data: DownloadedMarketData = {
    coin: input.coin,
    interval: "1m",
    intervalMs: ONE_MINUTE_MS,
    requestedStart: input.requestedStart,
    requestedEnd: input.requestedEnd,
    bars: validated.bars,
    quality: validated.quality,
  };
  const snapshot = await writeMarketSnapshot(data, join(outputDirectory, "partitions", input.month), input.identity);
  return {
    month: input.month,
    manifestFile: snapshot.manifestPath,
    dataFile: snapshot.dataPath,
    rowCount: snapshot.manifest.rowCount,
    actualStart: snapshot.manifest.actualStart,
    actualEnd: snapshot.manifest.actualEnd,
    dataSha256: snapshot.manifest.dataSha256,
    gaps: snapshot.manifest.quality.gaps.reduce((sum, gap) => sum + gap.missingBars, 0),
  };
}

export async function findVerifiedPartition(outputDirectory: string, month: string): Promise<HistoricalPartition | undefined> {
  const directory = resolve(outputDirectory, "partitions", month);
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return undefined;
  }
  const manifestName = files.find((file) => file.endsWith(".manifest.json"));
  if (!manifestName) return undefined;
  const manifestPath = join(directory, manifestName);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MarketSnapshotManifest;
  const dataPath = join(directory, manifest.dataFile);
  if ((await sha256File(dataPath)) !== manifest.dataSha256) return undefined;
  return {
    month,
    manifestFile: manifestPath,
    dataFile: dataPath,
    rowCount: manifest.rowCount,
    actualStart: manifest.actualStart,
    actualEnd: manifest.actualEnd,
    dataSha256: manifest.dataSha256,
    gaps: manifest.quality.gaps.reduce((sum, gap) => sum + gap.missingBars, 0),
  };
}

export async function writeDatasetCatalog(
  outputDirectory: string,
  metadata: Pick<HistoricalDatasetCatalog, "source" | "venue" | "instrument" | "requestedStart" | "requestedEnd">,
  partitions: HistoricalPartition[],
): Promise<string> {
  const sorted = [...partitions].sort((left, right) => left.month.localeCompare(right.month));
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) throw new Error("Cannot create an empty historical dataset catalog.");
  const rowCount = sorted.reduce((sum, partition) => sum + partition.rowCount, 0);
  const expectedMinutes = Math.ceil((metadata.requestedEnd - metadata.requestedStart) / ONE_MINUTE_MS);
  const absoluteOutput = resolve(outputDirectory);
  const catalog: HistoricalDatasetCatalog = {
    schemaVersion: "1.0",
    datasetId: `${metadata.venue}-${metadata.instrument.toLowerCase().replaceAll("/", "-")}-1m-${monthKey(metadata.requestedStart)}-${monthKey(metadata.requestedEnd - 1)}`,
    createdAt: new Date().toISOString(),
    ...metadata,
    interval: "1m",
    actualStart: first.actualStart,
    actualEnd: last.actualEnd,
    rowCount,
    expectedMinutes,
    observedMissingMinutes: Math.max(0, expectedMinutes - rowCount),
    partitions: sorted.map((partition) => ({
      ...partition,
      manifestFile: relative(absoluteOutput, resolve(partition.manifestFile)),
      dataFile: relative(absoluteOutput, resolve(partition.dataFile)),
    })),
  };
  await mkdir(outputDirectory, { recursive: true });
  const path = resolve(outputDirectory, "dataset.catalog.json");
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  return path;
}

export async function loadHistoricalDataset(catalogPath: string): Promise<{
  catalog: HistoricalDatasetCatalog;
  bars: MarketBar[];
}> {
  const absoluteCatalog = resolve(catalogPath);
  const catalog = JSON.parse(await readFile(absoluteCatalog, "utf8")) as HistoricalDatasetCatalog;
  if (catalog.schemaVersion !== "1.0" || catalog.interval !== "1m" || !Array.isArray(catalog.partitions)) {
    throw new Error("Unsupported or malformed historical dataset catalog.");
  }
  const bars: MarketBar[] = [];
  for (const partition of catalog.partitions) {
    const manifestPath = resolve(dirname(absoluteCatalog), partition.manifestFile);
    const loaded = await loadMarketSnapshot(manifestPath);
    if (loaded.manifest.dataSha256 !== partition.dataSha256 || loaded.bars.length !== partition.rowCount) {
      throw new Error(`Catalog metadata does not match partition ${partition.month}.`);
    }
    bars.push(...loaded.bars);
  }
  if (bars.length !== catalog.rowCount) {
    throw new Error(`Catalog row count mismatch: expected ${catalog.rowCount}, received ${bars.length}.`);
  }
  return { catalog, bars };
}

export async function downloadWithResume(url: string, destination: string): Promise<string> {
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  let offset = 0;
  try {
    offset = (await stat(partial)).size;
  } catch {
    // No partial download yet.
  }
  const response = await fetch(url, { headers: offset > 0 ? { range: `bytes=${offset}-` } : {} });
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  const append = offset > 0 && response.status === 206;
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial, { flags: append ? "a" : "w" }));
  await rename(partial, destination);
  return destination;
}

export async function ensureDownload(url: string, destination: string): Promise<string> {
  try {
    if ((await stat(destination)).size > 0) return destination;
  } catch {
    // Download below.
  }
  return downloadWithResume(url, destination);
}

export async function zipEntries(archivePath: string): Promise<string[]> {
  const child = spawn("unzip", ["-Z1", archivePath], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (output += chunk));
  child.stderr.on("data", (chunk: string) => (errorOutput += chunk));
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", resolvePromise);
  });
  if (code !== 0) throw new Error(`Cannot inspect ${archivePath}: ${errorOutput.trim()}`);
  return output.split(/\r?\n/).filter(Boolean);
}

export async function forEachZipLine(archivePath: string, entry: string, callback: (line: string) => Promise<void> | void): Promise<void> {
  const child = spawn("unzip", ["-p", archivePath, entry], { stdio: ["ignore", "pipe", "pipe"] });
  let errorOutput = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (errorOutput += chunk));
  const exit = new Promise<number | null>((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", resolvePromise);
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of lines) await callback(line);
  const code = await exit;
  if (code !== 0) throw new Error(`Cannot extract ${entry} from ${archivePath}: ${errorOutput.trim()}`);
}

export function archiveBasename(path: string): string {
  return basename(path);
}
