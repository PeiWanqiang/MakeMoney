import {
  authorIdHash,
  detectLanguage,
  extractRelevantText,
  markdownToText,
  PERMISSIVE_GITHUB_LICENSES,
  scoreIntentText,
  sha256,
  stableSourceId,
} from "./pipeline.js";
import type { InternetIntentCandidate } from "./types.js";

interface GitHubRepository {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  pushed_at: string;
  default_branch: string;
  archived: boolean;
  owner: { id: number; login: string; html_url: string };
  license: { spdx_id: string | null; name: string | null; url: string | null } | null;
}

interface GitHubSearchResponse {
  items?: GitHubRepository[];
  total_count?: number;
  incomplete_results?: boolean;
  message?: string;
}

export interface GitHubSearchRequest {
  query: string;
  page: number;
  pageSize: number;
}

export interface GitHubSearchResult {
  candidates: InternetIntentCandidate[];
  incompleteResults: boolean;
  hasMore: boolean;
  skippedWithoutLicense: number;
  skippedWithoutReadme: number;
}

export function defaultGitHubRequests(page: number, pageSize: number): GitHubSearchRequest[] {
  return [
    { query: '"entry conditions" "exit conditions" crypto trading in:readme archived:false', page, pageSize },
    { query: '"buy when" "sell when" trading strategy in:readme archived:false', page, pageSize },
    { query: '"long when" "close when" crypto strategy in:readme archived:false', page, pageSize },
    { query: 'freqtrade "entry" "exit" strategy in:readme archived:false', page, pageSize },
  ];
}

export function githubRequestKey(request: GitHubSearchRequest): string {
  return [request.query, request.page, request.pageSize].join("|");
}

export function githubSeriesKey(request: GitHubSearchRequest): string {
  return `terminal|${[request.query, request.pageSize].join("|")}`;
}

function headers(token: string | undefined, accept = "application/vnd.github+json"): Record<string, string> {
  return {
    accept,
    "user-agent": "crypto-strategy-studio-intent-research/0.1",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function responseError(response: Response): Promise<Error> {
  const body = (await response.text()).slice(0, 1_000);
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");
  const resetText = reset ? new Date(Number(reset) * 1_000).toISOString() : "unknown";
  return new Error(`GitHub API ${response.status}: ${body || response.statusText}; remaining=${remaining ?? "unknown"}; reset=${resetText}`);
}

async function fetchReadme(repository: GitHubRepository, token: string | undefined): Promise<{ text: string; path: string } | undefined> {
  const response = await fetch(`https://api.github.com/repos/${repository.full_name}/readme`, {
    headers: headers(token, "application/vnd.github.raw+json"),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw await responseError(response);
  const path = response.headers.get("content-location")?.split("/").at(-1) ?? "README";
  return { text: await response.text(), path };
}

export async function fetchGitHubRepositories(
  request: GitHubSearchRequest,
  token = process.env.GITHUB_TOKEN,
): Promise<GitHubSearchResult> {
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", request.query);
  url.searchParams.set("page", String(request.page));
  url.searchParams.set("per_page", String(request.pageSize));
  url.searchParams.set("sort", "updated");
  url.searchParams.set("order", "desc");
  const response = await fetch(url, { headers: headers(token) });
  if (!response.ok) throw await responseError(response);
  const payload = await response.json() as GitHubSearchResponse;
  const fetchedAt = new Date().toISOString();
  let skippedWithoutLicense = 0;
  let skippedWithoutReadme = 0;
  const candidates: InternetIntentCandidate[] = [];
  for (const repository of payload.items ?? []) {
    const licenseId = repository.license?.spdx_id ?? "";
    if (repository.archived || !PERMISSIVE_GITHUB_LICENSES.has(licenseId)) {
      skippedWithoutLicense += 1;
      continue;
    }
    const readme = await fetchReadme(repository, token);
    if (!readme) {
      skippedWithoutReadme += 1;
      continue;
    }
    const title = repository.full_name;
    const body = markdownToText([repository.description ?? "", readme.text].filter(Boolean).join("\n\n"));
    const rawText = extractRelevantText(title, body);
    if (!rawText) continue;
    candidates.push({
      schemaVersion: "1.0",
      id: stableSourceId("github", repository.full_name),
      source: "github",
      sourceRecordId: repository.full_name,
      sourceUrl: repository.html_url,
      sourceHost: "github.com",
      title,
      rawText,
      rawSha256: sha256(rawText),
      language: detectLanguage(rawText),
      publishedAt: repository.pushed_at,
      fetchedAt,
      tags: ["github", "readme", licenseId].sort(),
      license: {
        id: licenseId,
        url: repository.license?.url ?? `https://spdx.org/licenses/${licenseId}.html`,
        attribution: `${repository.full_name} contributors; source repository retained.`,
      },
      author: {
        idHash: authorIdHash("github", String(repository.owner.id)),
        displayName: repository.owner.login,
        profileUrl: repository.owner.html_url,
      },
      relevance: scoreIntentText(rawText),
      reviewStatus: "unreviewed",
      repository: {
        fullName: repository.full_name,
        defaultBranch: repository.default_branch,
        filePath: readme.path,
      },
    });
  }
  return {
    candidates,
    incompleteResults: payload.incomplete_results ?? false,
    hasMore: request.page * request.pageSize < (payload.total_count ?? 0),
    skippedWithoutLicense,
    skippedWithoutReadme,
  };
}
