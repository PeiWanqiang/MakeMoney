import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

import {
  deduplicateCandidates,
  readJsonLines,
  scoreIntentText,
  writeJsonLinesAtomic,
} from "../src/internet-intents/pipeline.js";
import type { InternetIntentCandidate } from "../src/internet-intents/types.js";

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

function countBy(values: InternetIntentCandidate[], select: (value: InternetIntentCandidate) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) {
    const key = select(value);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

const args = parseArguments(process.argv.slice(2));
const inputs = (args.get("inputs") ?? "data/internet-intents/raw/stackexchange.jsonl,data/internet-intents/raw/github.jsonl")
  .split(",")
  .map((value) => resolve(value.trim()))
  .filter(Boolean);
const output = resolve(args.get("output") ?? "data/internet-intents/candidates/candidates.jsonl");
const reportPath = resolve(args.get("report") ?? "data/internet-intents/candidates/summary.json");
const minimumScore = Number(args.get("minimum-score") ?? "0.3");
const nearThreshold = Number(args.get("near-threshold") ?? "0.9");
if (!Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 1) throw new Error("--minimum-score must be between 0 and 1.");
if (!Number.isFinite(nearThreshold) || nearThreshold < 0.5 || nearThreshold > 1) throw new Error("--near-threshold must be between 0.5 and 1.");

const loaded = (await Promise.all(inputs.map((path) => readJsonLines<InternetIntentCandidate>(path)))).flat();
const rescored = loaded.map((candidate) => ({ ...candidate, relevance: scoreIntentText(candidate.rawText) }));
const relevant = rescored.filter((candidate) => candidate.relevance.score >= minimumScore);
const deduplicated = deduplicateCandidates(relevant, nearThreshold);
await writeJsonLinesAtomic(output, deduplicated.kept);
await mkdir(dirname(reportPath), { recursive: true });
const report = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  inputs,
  thresholds: { minimumScore, nearThreshold },
  counts: {
    loaded: loaded.length,
    relevant: relevant.length,
    kept: deduplicated.kept.length,
    duplicatesRemoved: deduplicated.removed.length,
  },
  bySource: countBy(deduplicated.kept, (candidate) => candidate.source),
  byLanguage: countBy(deduplicated.kept, (candidate) => candidate.language),
  byLicense: countBy(deduplicated.kept, (candidate) => candidate.license.id),
  duplicates: deduplicated.removed,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, report: reportPath, ...report.counts, bySource: report.bySource, byLanguage: report.byLanguage }, null, 2));
