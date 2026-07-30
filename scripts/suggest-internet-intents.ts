import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DeepSeekInternetIntentSuggestionProvider } from "../src/internet-intents/deepseek-suggestion-provider.js";
import { readJsonLines, writeJsonLinesAtomic } from "../src/internet-intents/pipeline.js";
import {
  compareLaneSuggestions,
  segmentIntentText,
  unavailableLane,
  type InternetIntentLaneSuggestion,
  type InternetIntentSuggestionLane,
  type InternetIntentSuggestionReport,
} from "../src/internet-intents/suggestions.js";
import type { InternetIntentReviewQueueItem } from "../src/internet-intents/review.js";

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

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

const args = parseArguments(process.argv.slice(2));
const queuePath = resolve(args.get("queue") ?? "data/internet-intents/review/queue-reviewer-1.json");
const output = resolve(args.get("output") ?? "data/internet-intents/review/suggestions.jsonl");
const limit = positiveInteger(args.get("limit") ?? "25", "--limit");
const concurrency = positiveInteger(args.get("concurrency") ?? "2", "--concurrency");
const model = args.get("model") ?? process.env.DEEPSEEK_STRATEGY_MODEL ?? "deepseek-v4-pro";
const queue = JSON.parse(await readFile(queuePath, "utf8")) as { items?: InternetIntentReviewQueueItem[] };
if (!Array.isArray(queue.items)) throw new Error("Queue JSON does not contain an items array.");
const existing = await readJsonLines<InternetIntentSuggestionReport>(output);
const reports = new Map(existing.map((report) => [report.candidateId, report]));
const selected = queue.items.slice(0, limit);
const pending = selected.filter(({ candidate }) => {
  const report = reports.get(candidate.id);
  return !report || report.candidateSha256 !== candidate.rawSha256 || report.generator !== `deepseek:${model}:dual-lane-v1` ||
    report.lanes.some((lane) => lane.status === "error");
});
const provider = new DeepSeekInternetIntentSuggestionProvider({ model });
let cursor = 0;
let completedPending = 0;
let persist = Promise.resolve();

async function analyzeLane(item: InternetIntentReviewQueueItem, lane: InternetIntentSuggestionLane, input: string): Promise<InternetIntentLaneSuggestion> {
  if (input.trim().length < 40) return unavailableLane(lane, input);
  try {
    return await provider.suggest(item.candidate, lane, input);
  } catch (error) {
    return unavailableLane(lane, input, error instanceof Error ? error.message : String(error));
  }
}

async function worker(): Promise<void> {
  while (cursor < pending.length) {
    const item = pending[cursor];
    cursor += 1;
    if (!item) return;
    const segments = segmentIntentText(item.candidate.rawText);
    const lanes = await Promise.all([
      analyzeLane(item, "prose", segments.prose),
      analyzeLane(item, "code", segments.code),
    ]);
    const report: InternetIntentSuggestionReport = {
      schemaVersion: "1.0",
      candidateId: item.candidate.id,
      candidateSha256: item.candidate.rawSha256,
      generatedAt: new Date().toISOString(),
      generator: `deepseek:${model}:dual-lane-v1`,
      lanes,
      comparison: compareLaneSuggestions(lanes),
      warning: "AI suggestions are reviewer aids only and must never be imported as submitted annotations.",
    };
    reports.set(item.candidate.id, report);
    const ordered = [...reports.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId));
    persist = persist.then(() => writeJsonLinesAtomic(output, ordered));
    await persist;
    completedPending += 1;
    console.log(JSON.stringify({
      progress: `${selected.length - pending.length + completedPending}/${selected.length}`,
      candidateId: item.candidate.id,
      lanes: Object.fromEntries(lanes.map((lane) => [lane.lane, lane.status])),
      comparison: report.comparison.status,
    }));
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
const selectedReports = selected.map(({ candidate }) => reports.get(candidate.id)).filter((value): value is InternetIntentSuggestionReport => value !== undefined);
const laneErrors = selectedReports.flatMap((report) => report.lanes).filter((lane) => lane.status === "error").length;
console.log(JSON.stringify({
  output,
  selected: selected.length,
  completed: selectedReports.length,
  laneErrors,
  comparisons: {
    agree: selectedReports.filter((report) => report.comparison.status === "agree").length,
    conflict: selectedReports.filter((report) => report.comparison.status === "conflict").length,
    insufficient: selectedReports.filter((report) => report.comparison.status === "insufficient").length,
  },
}, null, 2));
if (laneErrors > 0) process.exitCode = 1;
