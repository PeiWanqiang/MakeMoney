import { resolve } from "node:path";

import {
  defaultGitHubRequests,
  fetchGitHubRepositories,
  githubRequestKey,
  githubSeriesKey,
  type GitHubSearchRequest,
} from "../src/internet-intents/github.js";
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
const pages = positiveInteger(args.get("pages") ?? "1", "--pages", 10);
const pageSize = positiveInteger(args.get("page-size") ?? "10", "--page-size", 50);
const output = resolve(args.get("output") ?? "data/internet-intents/raw/github.jsonl");
const checkpointPath = resolve(args.get("checkpoint") ?? `${output}.checkpoint.json`);
const completed = await readCheckpoint(checkpointPath);

for (let page = 1; page <= pages; page += 1) {
  const requests: GitHubSearchRequest[] = args.get("query")
    ? [{ query: args.get("query") ?? "crypto trading strategy", page, pageSize }]
    : defaultGitHubRequests(page, pageSize);
  for (const request of requests) {
    const key = githubRequestKey(request);
    const seriesKey = githubSeriesKey(request);
    if (completed.has(seriesKey)) {
      console.log(JSON.stringify({ source: "github", status: "terminal-skip", key }));
      continue;
    }
    if (completed.has(key)) {
      console.log(JSON.stringify({ source: "github", status: "checkpoint-skip", key }));
      continue;
    }
    const result = await fetchGitHubRepositories(request);
    const total = await mergeCandidatesAtomic(output, result.candidates);
    completed.add(key);
    if (!result.hasMore) completed.add(seriesKey);
    await writeCheckpoint(checkpointPath, completed);
    console.log(JSON.stringify({
      source: "github",
      key,
      fetched: result.candidates.length,
      stored: total,
      skippedWithoutLicense: result.skippedWithoutLicense,
      skippedWithoutReadme: result.skippedWithoutReadme,
      incompleteResults: result.incompleteResults,
      hasMore: result.hasMore,
    }));
  }
}

console.log(JSON.stringify({
  output,
  checkpoint: checkpointPath,
  authenticated: Boolean(process.env.GITHUB_TOKEN),
}, null, 2));
