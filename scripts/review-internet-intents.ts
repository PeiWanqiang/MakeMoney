import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { readJsonLines, writeJsonLinesAtomic } from "../src/internet-intents/pipeline.js";
import {
  buildGoldenCorpus,
  blindReviewQueueItem,
  mergeReview,
  parseReview,
  selectReviewQueue,
  type InternetIntentAnnotation,
  type InternetIntentReview,
} from "../src/internet-intents/review.js";
import type { InternetIntentCandidate, InternetIntentLanguage, InternetIntentSource } from "../src/internet-intents/types.js";

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

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function booleanValue(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function countAnnotations(annotations: InternetIntentAnnotation[]): object {
  const disposition: Record<string, number> = {};
  let independentReviews = 0;
  let adjudicated = 0;
  for (const annotation of annotations) {
    independentReviews += annotation.reviews.length;
    if (annotation.adjudication) adjudicated += 1;
    const resolved = annotation.adjudication ?? (annotation.reviews.length === 1 ? annotation.reviews[0] : undefined);
    const key = resolved?.disposition ?? "unresolved";
    disposition[key] = (disposition[key] ?? 0) + 1;
  }
  return { annotations: annotations.length, independentReviews, adjudicated, disposition };
}

const [command = "help", ...argumentValues] = process.argv.slice(2);
const args = parseArguments(argumentValues);
const candidatesPath = resolve(args.get("candidates") ?? "data/internet-intents/candidates/candidates.jsonl");
const annotationsPath = resolve(args.get("annotations") ?? "data/internet-intents/review/annotations.jsonl");

if (command === "queue") {
  const reviewerId = args.get("reviewer");
  if (!reviewerId) throw new Error("queue requires --reviewer reviewer-id.");
  const limit = positiveInteger(args.get("limit") ?? "25", "--limit");
  const source = args.get("source");
  const language = args.get("language");
  const relevance = args.get("relevance");
  const blind = args.has("blind") ? booleanValue(args.get("blind") ?? "", "--blind") : false;
  if (source && source !== "stackexchange" && source !== "github") throw new Error("--source must be stackexchange or github.");
  if (language && !["en", "zh", "mixed", "unknown"].includes(language)) throw new Error("--language is invalid.");
  if (relevance && !["likely", "possible", "unlikely"].includes(relevance)) throw new Error("--relevance is invalid.");
  const candidates = await readJsonLines<InternetIntentCandidate>(candidatesPath);
  const annotations = await readJsonLines<InternetIntentAnnotation>(annotationsPath);
  const items = selectReviewQueue(candidates, annotations, {
    reviewerId,
    limit,
    ...(source ? { source: source as InternetIntentSource } : {}),
    ...(language ? { language: language as InternetIntentLanguage } : {}),
    ...(relevance ? { relevance: relevance as InternetIntentCandidate["relevance"]["status"] } : {}),
  });
  const output = resolve(args.get("output") ?? `data/internet-intents/review/queue-${reviewerId}.json`);
  const outputItems = blind
    ? items.map(blindReviewQueueItem)
    : items;
  await writeJsonAtomic(output, {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    reviewerId,
    blind,
    count: outputItems.length,
    instructions: blind
      ? "Blind review: source, author, relevance scores and AI suggestions are intentionally hidden. Edit each review object, then submit one review JSON at a time."
      : "Edit each review object, set status=submitted and submittedAt, then submit one review JSON at a time.",
    items: outputItems,
  });
  console.log(JSON.stringify({ command, output, count: outputItems.length, reviewerId, blind }, null, 2));
} else if (command === "submit") {
  const input = args.get("file");
  if (!input) throw new Error("submit requires --file review.json.");
  const parsed = JSON.parse(await readFile(resolve(input), "utf8")) as unknown;
  const wrapped = typeof parsed === "object" && parsed !== null && "review" in parsed
    ? (parsed as { review: unknown }).review
    : parsed;
  const review = parseReview(wrapped);
  const candidates = await readJsonLines<InternetIntentCandidate>(candidatesPath);
  const candidate = candidates.find((item) => item.id === review.candidateId);
  if (!candidate) throw new Error(`Candidate ${review.candidateId} was not found.`);
  const annotations = await readJsonLines<InternetIntentAnnotation>(annotationsPath);
  const existing = annotations.find((annotation) => annotation.candidateId === candidate.id);
  const merged = mergeReview(candidate, existing, review);
  const updated = annotations.filter((annotation) => annotation.candidateId !== candidate.id);
  updated.push(merged);
  updated.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  await writeJsonLinesAtomic(annotationsPath, updated);
  console.log(JSON.stringify({ command, annotations: annotationsPath, candidateId: candidate.id, reviewId: review.reviewId, kind: review.kind }, null, 2));
} else if (command === "stats") {
  const candidates = await readJsonLines<InternetIntentCandidate>(candidatesPath);
  const annotations = await readJsonLines<InternetIntentAnnotation>(annotationsPath);
  console.log(JSON.stringify({ candidates: candidates.length, pending: candidates.length - annotations.length, ...countAnnotations(annotations) }, null, 2));
} else if (command === "export") {
  const candidates = await readJsonLines<InternetIntentCandidate>(candidatesPath);
  const annotations = await readJsonLines<InternetIntentAnnotation>(annotationsPath);
  const minimumIndependentReviews = positiveInteger(args.get("minimum-reviewers") ?? "2", "--minimum-reviewers");
  const requireAdjudication = args.has("require-adjudication")
    ? booleanValue(args.get("require-adjudication") ?? "", "--require-adjudication")
    : minimumIndependentReviews >= 2;
  const output = resolve(args.get("output") ?? "data/internet-intents/golden/golden.jsonl");
  const manifestPath = resolve(args.get("manifest") ?? "data/internet-intents/golden/manifest.json");
  const result = buildGoldenCorpus(candidates, annotations, {
    minimumIndependentReviews,
    requireAdjudication,
    splitSalt: args.get("split-salt") ?? "internet-intents-v1",
  });
  await writeJsonLinesAtomic(output, result.records);
  await writeJsonAtomic(manifestPath, result.manifest);
  console.log(JSON.stringify({ command, output, manifest: manifestPath, ...result.manifest.counts, corpusSha256: result.manifest.corpusSha256 }, null, 2));
} else {
  console.log(`Usage:
  npm run intents:review -- queue --reviewer ID [--limit 25] [--blind true] [--output PATH]
  npm run intents:review -- submit --file REVIEW.json
  npm run intents:review -- stats
  npm run intents:review -- export [--minimum-reviewers 2] [--require-adjudication true]

All commands accept --candidates PATH and --annotations PATH.`);
  if (command !== "help") process.exitCode = 1;
}
