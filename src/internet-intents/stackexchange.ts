import {
  authorIdHash,
  detectLanguage,
  extractRelevantText,
  htmlToText,
  scoreIntentText,
  sha256,
  stableSourceId,
} from "./pipeline.js";
import type { InternetIntentCandidate, InternetIntentLicense } from "./types.js";

interface StackExchangeOwner {
  user_id?: number;
  display_name?: string;
  link?: string;
}

interface StackExchangeQuestion {
  question_id: number;
  title: string;
  body?: string;
  link: string;
  creation_date: number;
  tags?: string[];
  owner?: StackExchangeOwner;
}

interface StackExchangeResponse {
  items?: StackExchangeQuestion[];
  has_more?: boolean;
  backoff?: number;
  quota_remaining?: number;
  error_message?: string;
}

export interface StackExchangePageRequest {
  site: "stackoverflow" | "quant";
  query: string;
  tagged?: string;
  page: number;
  pageSize: number;
}

export interface StackExchangePageResult {
  candidates: InternetIntentCandidate[];
  hasMore: boolean;
  backoffSeconds: number;
  quotaRemaining: number | null;
}

function contributionLicense(createdAtSeconds: number): InternetIntentLicense {
  const createdAt = createdAtSeconds * 1_000;
  if (createdAt < Date.parse("2011-04-08T00:00:00Z")) return {
    id: "CC-BY-SA-2.5",
    url: "https://creativecommons.org/licenses/by-sa/2.5/",
    attribution: "Stack Exchange contribution; author and source link retained.",
  };
  if (createdAt < Date.parse("2018-05-02T00:00:00Z")) return {
    id: "CC-BY-SA-3.0",
    url: "https://creativecommons.org/licenses/by-sa/3.0/",
    attribution: "Stack Exchange contribution; author and source link retained.",
  };
  return {
    id: "CC-BY-SA-4.0",
    url: "https://creativecommons.org/licenses/by-sa/4.0/",
    attribution: "Stack Exchange contribution; author and source link retained.",
  };
}

export function defaultStackExchangeRequests(page: number, pageSize: number): StackExchangePageRequest[] {
  return [
    { site: "stackoverflow", tagged: "pine-script", query: "strategy entry exit", page, pageSize },
    { site: "stackoverflow", tagged: "pine-script", query: "stop loss take profit", page, pageSize },
    { site: "quant", query: "algorithmic trading strategy entry exit", page, pageSize },
    { site: "quant", query: "crypto trading strategy", page, pageSize },
  ];
}

export function stackExchangeRequestKey(request: StackExchangePageRequest): string {
  return [request.site, request.tagged ?? "", request.query, request.page, request.pageSize].join("|");
}

export function stackExchangeSeriesKey(request: StackExchangePageRequest): string {
  return `terminal|${[request.site, request.tagged ?? "", request.query, request.pageSize].join("|")}`;
}

export async function fetchStackExchangePage(request: StackExchangePageRequest): Promise<StackExchangePageResult> {
  const url = new URL("https://api.stackexchange.com/2.3/search/advanced");
  url.searchParams.set("site", request.site);
  url.searchParams.set("q", request.query);
  url.searchParams.set("page", String(request.page));
  url.searchParams.set("pagesize", String(request.pageSize));
  url.searchParams.set("order", "desc");
  url.searchParams.set("sort", "creation");
  url.searchParams.set("filter", "withbody");
  if (request.tagged) url.searchParams.set("tagged", request.tagged);
  const response = await fetch(url, { headers: { "user-agent": "crypto-strategy-studio-intent-research/0.1" } });
  const payload = await response.json() as StackExchangeResponse;
  if (!response.ok || payload.error_message) {
    throw new Error(`Stack Exchange API ${response.status}: ${payload.error_message ?? response.statusText}`);
  }
  const fetchedAt = new Date().toISOString();
  const candidates = (payload.items ?? []).map((question): InternetIntentCandidate => {
    const title = htmlToText(question.title);
    const body = htmlToText(question.body ?? "");
    const rawText = extractRelevantText(title, body);
    const ownerId = String(question.owner?.user_id ?? question.owner?.link ?? "unknown");
    return {
      schemaVersion: "1.0",
      id: stableSourceId("stackexchange", `${request.site}:${question.question_id}`),
      source: "stackexchange",
      sourceRecordId: `${request.site}:${question.question_id}`,
      sourceUrl: question.link,
      sourceHost: new URL(question.link).host,
      title,
      rawText,
      rawSha256: sha256(rawText),
      language: detectLanguage(rawText),
      publishedAt: new Date(question.creation_date * 1_000).toISOString(),
      fetchedAt,
      tags: [...new Set(question.tags ?? [])].sort(),
      license: contributionLicense(question.creation_date),
      author: {
        idHash: authorIdHash("stackexchange", ownerId),
        displayName: htmlToText(question.owner?.display_name ?? "unknown"),
        profileUrl: question.owner?.link ?? null,
      },
      relevance: scoreIntentText(rawText),
      reviewStatus: "unreviewed",
      repository: null,
    };
  });
  return {
    candidates,
    hasMore: payload.has_more ?? false,
    backoffSeconds: payload.backoff ?? 0,
    quotaRemaining: payload.quota_remaining ?? null,
  };
}
