import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  InternetIntentCandidate,
  InternetIntentDeduplicationResult,
  InternetIntentLanguage,
  InternetIntentRelevance,
} from "./types.js";

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

const SIGNAL_GROUPS: Array<{ name: string; weight: number; patterns: RegExp[] }> = [
  {
    name: "strategy-request",
    weight: 0.2,
    patterns: [/\bstrateg(?:y|ies)\b/i, /\bbacktest/i, /\btrading rule/i, /策略|回测|交易规则/],
  },
  {
    name: "entry-action",
    weight: 0.22,
    patterns: [/\b(?:enter|entry|buy|go long|sell short|open (?:a )?position)\b/i, /strategy\.entry/i, /做多|做空|开仓|入场/],
  },
  {
    name: "exit-risk",
    weight: 0.22,
    patterns: [/\b(?:exit|close|stop[ -]?loss|take[ -]?profit|trailing stop)\b/i, /strategy\.(?:close|exit)/i, /平仓|退出|止损|止盈|移动止损/],
  },
  {
    name: "conditional-rule",
    weight: 0.16,
    patterns: [/\b(?:when|if|whenever|cross(?:es|ed)?|above|below|greater than|less than)\b/i, /当|如果|上穿|下穿|高于|低于|突破|跌破/],
  },
  {
    name: "indicator",
    weight: 0.12,
    patterns: [/\b(?:EMA|SMA|RSI|MACD|ATR|Bollinger|Donchian|moving average|funding rate|open interest)\b/i, /均线|相对强弱|布林|唐奇安|资金费率|持仓量/],
  },
  {
    name: "timeframe",
    weight: 0.08,
    patterns: [/\b(?:[0-9]+\s*(?:m|min|minute|h|hour|d|day)s?|daily|weekly|timeframe|bar close)\b/i, /[0-9]+\s*(?:分钟|小时|日|天|周)|周期|收盘/],
  },
];

export const PERMISSIVE_GITHUB_LICENSES = new Set([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "Unlicense",
]);

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableSourceId(source: string, sourceRecordId: string): string {
  return `${source}-${sha256(`${source}:${sourceRecordId}`).slice(0, 24)}`;
}

export function authorIdHash(source: string, authorId: string): string {
  return sha256(`${source}:author:${authorId}`);
}

export function htmlToText(input: string): string {
  return input
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(?:p|div|li|pre|blockquote|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const value = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(value) ? String.fromCodePoint(value) : " ";
      }
      if (entity.startsWith("#")) {
        const value = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(value) ? String.fromCodePoint(value) : " ";
      }
      return HTML_ENTITIES[entity.toLowerCase()] ?? " ";
    })
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function markdownToText(input: string): string {
  return input
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/```[a-z0-9_-]*\n?/gi, "\n")
    .replace(/```/g, "\n")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function detectLanguage(value: string): InternetIntentLanguage {
  const han = (value.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (value.match(/[A-Za-z]/g) ?? []).length;
  if (han === 0 && latin === 0) return "unknown";
  const hanFraction = han / Math.max(1, han + latin);
  if (han > 0 && latin > 0 && hanFraction >= 0.1 && hanFraction <= 0.9) return "mixed";
  return hanFraction > 0.9 ? "zh" : "en";
}

export function scoreIntentText(value: string): InternetIntentRelevance {
  const signals: string[] = [];
  let score = 0;
  for (const group of SIGNAL_GROUPS) {
    if (!group.patterns.some((pattern) => pattern.test(value))) continue;
    signals.push(group.name);
    score += group.weight;
  }
  const rounded = Math.round(Math.min(1, score) * 100) / 100;
  return {
    score: rounded,
    status: rounded >= 0.55 ? "likely" : rounded >= 0.3 ? "possible" : "unlikely",
    signals,
  };
}

export function extractRelevantText(title: string, body: string, maxCharacters = 8_000): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((paragraph, index) => ({ index, paragraph: paragraph.trim(), score: scoreIntentText(paragraph).score }))
    .filter((item) => item.paragraph.length >= 20);
  const relevant = paragraphs.filter((item) => item.score >= 0.3);
  const selected = (relevant.length > 0
    ? [...relevant].sort((left, right) => right.score - left.score || left.index - right.index).slice(0, 12)
    : paragraphs.slice(0, 8))
    .sort((left, right) => left.index - right.index)
    .map((item) => item.paragraph);
  const combined = [title.trim(), ...selected].filter(Boolean).join("\n\n");
  return combined.slice(0, maxCharacters).trim();
}

function normalizedTokens(value: string): Set<string> {
  const normalized = value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\u3400-\u9fff.%-]+/g, " ")
    .trim();
  const words = normalized.split(/\s+/).filter((word) => word.length >= 2);
  const shingles = new Set<string>();
  for (let index = 0; index < words.length - 2; index += 1) {
    shingles.add(`${words[index]} ${words[index + 1]} ${words[index + 2]}`);
  }
  return shingles.size > 0 ? shingles : new Set(words);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export function deduplicateCandidates(
  input: InternetIntentCandidate[],
  nearThreshold = 0.9,
): InternetIntentDeduplicationResult {
  const ranked = [...input].sort((left, right) =>
    right.relevance.score - left.relevance.score || left.id.localeCompare(right.id)
  );
  const kept: InternetIntentCandidate[] = [];
  const removed: InternetIntentDeduplicationResult["removed"] = [];
  const exact = new Map<string, InternetIntentCandidate>();
  const tokenSets = new Map<string, Set<string>>();
  for (const candidate of ranked) {
    const exactMatch = exact.get(candidate.rawSha256);
    if (exactMatch) {
      removed.push({ id: candidate.id, duplicateOf: exactMatch.id, similarity: 1, reason: "exact" });
      continue;
    }
    const candidateTokens = normalizedTokens(candidate.rawText);
    let nearMatch: { candidate: InternetIntentCandidate; similarity: number } | undefined;
    for (const existing of kept) {
      const similarity = jaccard(candidateTokens, tokenSets.get(existing.id) ?? new Set());
      if (similarity >= nearThreshold && (!nearMatch || similarity > nearMatch.similarity)) {
        nearMatch = { candidate: existing, similarity };
      }
    }
    if (nearMatch) {
      removed.push({
        id: candidate.id,
        duplicateOf: nearMatch.candidate.id,
        similarity: Math.round(nearMatch.similarity * 1_000) / 1_000,
        reason: "near",
      });
      continue;
    }
    exact.set(candidate.rawSha256, candidate);
    tokenSets.set(candidate.id, candidateTokens);
    kept.push(candidate);
  }
  return { kept: kept.sort((left, right) => left.id.localeCompare(right.id)), removed };
}

export async function readJsonLines<T>(path: string): Promise<T[]> {
  try {
    const contents = await readFile(path, "utf8");
    return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function writeJsonLinesAtomic(path: string, values: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, values.map((value) => JSON.stringify(value)).join("\n") + (values.length > 0 ? "\n" : ""), "utf8");
  await rename(temporary, path);
}

export async function mergeCandidatesAtomic(path: string, incoming: InternetIntentCandidate[]): Promise<number> {
  const existing = await readJsonLines<InternetIntentCandidate>(path);
  const byId = new Map(existing.map((candidate) => [candidate.id, candidate]));
  for (const candidate of incoming) byId.set(candidate.id, candidate);
  const merged = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  await writeJsonLinesAtomic(path, merged);
  return merged.length;
}

export async function readCheckpoint(path: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { completed?: unknown };
    return new Set(Array.isArray(parsed.completed) ? parsed.completed.filter((item): item is string => typeof item === "string") : []);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

export async function writeCheckpoint(path: string, completed: Set<string>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const value = { schemaVersion: "1.0", updatedAt: new Date().toISOString(), completed: [...completed].sort() };
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
