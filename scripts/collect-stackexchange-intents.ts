import { resolve } from "node:path";

import {
  defaultStackExchangeRequests,
  fetchStackExchangePage,
  stackExchangeRequestKey,
  stackExchangeSeriesKey,
  type StackExchangePageRequest,
} from "../src/internet-intents/stackexchange.js";
import { mergeCandidatesAtomic, readCheckpoint, writeCheckpoint } from "../src/internet-intents/pipeline.js";

function parseArguments(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error("Arguments must use --name value pairs.");
    result.set(name.slice(2), value);
  }
  return result;
}

function positiveInteger(value: string, name: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) throw new Error(`${name} must be between 1 and ${maximum}.`);
  return parsed;
}

const args = parseArguments(process.argv.slice(2));
const pages = positiveInteger(args.get("pages") ?? "1", "--pages", 25);
const pageSize = positiveInteger(args.get("page-size") ?? "50", "--page-size", 100);
const output = resolve(args.get("output") ?? "data/internet-intents/raw/stackexchange.jsonl");
const checkpointPath = resolve(args.get("checkpoint") ?? `${output}.checkpoint.json`);
const completed = await readCheckpoint(checkpointPath);

for (let page = 1; page <= pages; page += 1) {
  const query = args.get("query");
  const tagged = args.get("tagged");
  const requests: StackExchangePageRequest[] = query
    ? [{
        site: args.get("site") === "quant" ? "quant" : "stackoverflow",
        query,
        ...(tagged === undefined ? {} : { tagged }),
        page,
        pageSize,
      }]
    : defaultStackExchangeRequests(page, pageSize);
  for (const request of requests) {
    const key = stackExchangeRequestKey(request);
    const seriesKey = stackExchangeSeriesKey(request);
    if (completed.has(seriesKey)) {
      console.log(JSON.stringify({ source: "stackexchange", status: "terminal-skip", key }));
      continue;
    }
    if (completed.has(key)) {
      console.log(JSON.stringify({ source: "stackexchange", status: "checkpoint-skip", key }));
      continue;
    }
    const result = await fetchStackExchangePage(request);
    const total = await mergeCandidatesAtomic(output, result.candidates);
    completed.add(key);
    if (!result.hasMore) completed.add(seriesKey);
    await writeCheckpoint(checkpointPath, completed);
    console.log(JSON.stringify({
      source: "stackexchange",
      key,
      fetched: result.candidates.length,
      stored: total,
      quotaRemaining: result.quotaRemaining,
      hasMore: result.hasMore,
    }));
    if (result.backoffSeconds > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, result.backoffSeconds * 1_000));
    }
  }
}

console.log(JSON.stringify({ output, checkpoint: checkpointPath }, null, 2));
