import { resolve } from "node:path";

import { HyperliquidClient, ONE_MINUTE_MS } from "../src/data/hyperliquid-client.js";
import { writeMarketSnapshot } from "../src/data/market-snapshot.js";

function parseArgs(args: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument '${key ?? ""}'.`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Argument '${key}' requires a value.`);
    parsed.set(key.slice(2), value);
    index += 1;
  }
  return parsed;
}

function timestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.trunc(numeric);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid date '${value}'.`);
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const coin = (args.get("coin") ?? "BTC").toUpperCase();
const hours = Number(args.get("hours") ?? "72");
if (!Number.isFinite(hours) || hours <= 0 || hours > 82) {
  throw new Error("--hours must be greater than zero and no more than 82 because the API exposes only the latest 5000 one-minute candles.");
}

const defaultEnd = Math.floor(Date.now() / ONE_MINUTE_MS) * ONE_MINUTE_MS - 1;
const end = timestamp(args.get("end"), defaultEnd);
const start = timestamp(args.get("start"), end - hours * 60 * 60 * 1_000 + 1);
const output = resolve(args.get("output") ?? `data/snapshots/hyperliquid/${coin}/1m`);

const client = new HyperliquidClient();
const data = await client.downloadOneMinuteMarketData(coin, start, end);
const snapshot = await writeMarketSnapshot(data, output);

console.log(
  JSON.stringify(
    {
      manifestPath: snapshot.manifestPath,
      dataPath: snapshot.dataPath,
      rows: snapshot.manifest.rowCount,
      range: [new Date(snapshot.manifest.actualStart).toISOString(), new Date(snapshot.manifest.actualEnd).toISOString()],
      gaps: snapshot.manifest.quality.gaps.length,
      invalidCandles: snapshot.manifest.quality.invalidCandles,
      dataSha256: snapshot.manifest.dataSha256,
    },
    null,
    2,
  ),
);

