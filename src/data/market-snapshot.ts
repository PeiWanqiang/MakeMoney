import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { parquetWriteFile } from "hyparquet-writer";

import type { MarketBar } from "../core/types.js";
import type { DownloadedMarketData, MarketDataQuality } from "./hyperliquid-client.js";

export interface MarketSnapshotManifest {
  schemaVersion: "1.0";
  snapshotId: string;
  createdAt: string;
  source: "hyperliquid-api" | "binance-vision" | "kraken-ohlcvt";
  venue: "hyperliquid" | "binance-spot" | "kraken-spot";
  instrument: string;
  interval: "1m";
  intervalMs: number;
  requestedStart: number;
  requestedEnd: number;
  actualStart: number;
  actualEnd: number;
  rowCount: number;
  columns: string[];
  quality: MarketDataQuality;
  dataFile: string;
  dataSha256: string;
  provenance?: {
    url?: string;
    archiveFile?: string;
    archiveSha256?: string;
  };
}

export interface MarketSnapshotIdentity {
  source: MarketSnapshotManifest["source"];
  venue: MarketSnapshotManifest["venue"];
  instrument: string;
  filePrefix: string;
  provenance?: MarketSnapshotManifest["provenance"];
}

export interface WrittenMarketSnapshot {
  manifestPath: string;
  dataPath: string;
  manifest: MarketSnapshotManifest;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function datePart(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export async function writeMarketSnapshot(
  data: DownloadedMarketData,
  outputDirectory: string,
  identity: MarketSnapshotIdentity = {
    source: "hyperliquid-api",
    venue: "hyperliquid",
    instrument: `${data.coin}-PERP`,
    filePrefix: `hyperliquid-${data.coin.toLowerCase()}-perp`,
  },
): Promise<WrittenMarketSnapshot> {
  if (data.bars.length === 0) throw new Error("Cannot write an empty market snapshot.");
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const temporaryDataPath = join(directory, `.snapshot-${process.pid}-${Date.now()}.parquet.tmp`);

  try {
    await parquetWriteFile({
      filename: temporaryDataPath,
      columnData: [
        { name: "timestamp", data: data.bars.map((row) => row.timestamp), type: "DOUBLE", nullable: false },
        { name: "endTimestamp", data: data.bars.map((row) => row.endTimestamp), type: "DOUBLE", nullable: false },
        { name: "open", data: data.bars.map((row) => row.open), type: "DOUBLE", nullable: false },
        { name: "high", data: data.bars.map((row) => row.high), type: "DOUBLE", nullable: false },
        { name: "low", data: data.bars.map((row) => row.low), type: "DOUBLE", nullable: false },
        { name: "close", data: data.bars.map((row) => row.close), type: "DOUBLE", nullable: false },
        { name: "volume", data: data.bars.map((row) => row.volume), type: "DOUBLE", nullable: false },
        { name: "trades", data: data.bars.map((row) => row.trades), type: "INT32", nullable: false },
        { name: "fundingRate", data: data.bars.map((row) => row.fundingRate ?? 0), type: "DOUBLE", nullable: false },
        { name: "fundingPremium", data: data.bars.map((row) => row.fundingPremium), type: "DOUBLE", nullable: false },
      ],
      kvMetadata: [
        { key: "source", value: identity.source },
        { key: "venue", value: identity.venue },
        { key: "coin", value: data.coin },
        { key: "interval", value: "1m" },
        { key: "schemaVersion", value: "1.0" },
      ],
    });

    const dataSha256 = await sha256File(temporaryDataPath);
    const actualStart = data.bars[0]?.timestamp;
    const actualEnd = data.bars.at(-1)?.endTimestamp;
    if (actualStart === undefined || actualEnd === undefined) throw new Error("Snapshot boundaries are missing.");

    const base = `${identity.filePrefix}-1m-${datePart(actualStart)}-${datePart(actualEnd)}-${dataSha256.slice(0, 12)}`;
    const dataPath = join(directory, `${base}.parquet`);
    const manifestPath = join(directory, `${base}.manifest.json`);
    await rename(temporaryDataPath, dataPath);

    const manifest: MarketSnapshotManifest = {
      schemaVersion: "1.0",
      snapshotId: base,
      createdAt: new Date().toISOString(),
      source: identity.source,
      venue: identity.venue,
      instrument: identity.instrument,
      interval: "1m",
      intervalMs: data.intervalMs,
      requestedStart: data.requestedStart,
      requestedEnd: data.requestedEnd,
      actualStart,
      actualEnd,
      rowCount: data.bars.length,
      columns: [
        "timestamp",
        "endTimestamp",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "trades",
        "fundingRate",
        "fundingPremium",
      ],
      quality: data.quality,
      dataFile: basename(dataPath),
      dataSha256,
      ...(identity.provenance ? { provenance: identity.provenance } : {}),
    };
    const temporaryManifestPath = `${manifestPath}.tmp`;
    await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(temporaryManifestPath, manifestPath);
    return { manifestPath, dataPath, manifest };
  } catch (error) {
    await unlink(temporaryDataPath).catch(() => undefined);
    throw error;
  }
}

function requiredNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Snapshot column '${key}' contains an invalid value.`);
  }
  return value;
}

export async function loadMarketSnapshot(manifestPath: string): Promise<{
  manifest: MarketSnapshotManifest;
  bars: MarketBar[];
}> {
  const absoluteManifestPath = resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absoluteManifestPath, "utf8")) as MarketSnapshotManifest;
  if (manifest.schemaVersion !== "1.0" || manifest.interval !== "1m" || !manifest.dataFile || !manifest.dataSha256) {
    throw new Error("Unsupported or malformed market snapshot manifest.");
  }
  const dataPath = resolve(dirname(absoluteManifestPath), manifest.dataFile);
  const actualHash = await sha256File(dataPath);
  if (actualHash !== manifest.dataSha256) {
    throw new Error(`Snapshot hash mismatch: expected ${manifest.dataSha256}, received ${actualHash}.`);
  }

  const file = await asyncBufferFromFile(dataPath);
  const rows = await parquetReadObjects({ file });
  if (rows.length !== manifest.rowCount) {
    throw new Error(`Snapshot row count mismatch: expected ${manifest.rowCount}, received ${rows.length}.`);
  }
  const bars = rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      timestamp: requiredNumber(record, "timestamp"),
      open: requiredNumber(record, "open"),
      high: requiredNumber(record, "high"),
      low: requiredNumber(record, "low"),
      close: requiredNumber(record, "close"),
      volume: requiredNumber(record, "volume"),
      fundingRate: requiredNumber(record, "fundingRate"),
    } satisfies MarketBar;
  });
  return { manifest, bars };
}
