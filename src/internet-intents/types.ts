export type InternetIntentSource = "stackexchange" | "github";
export type InternetIntentLanguage = "en" | "zh" | "mixed" | "unknown";

export interface InternetIntentLicense {
  id: string;
  url: string;
  attribution: string;
}

export interface InternetIntentAuthor {
  idHash: string;
  displayName: string;
  profileUrl: string | null;
}

export interface InternetIntentRelevance {
  score: number;
  status: "likely" | "possible" | "unlikely";
  signals: string[];
}

export interface InternetIntentCandidate {
  schemaVersion: "1.0";
  id: string;
  source: InternetIntentSource;
  sourceRecordId: string;
  sourceUrl: string;
  sourceHost: string;
  title: string;
  rawText: string;
  rawSha256: string;
  language: InternetIntentLanguage;
  publishedAt: string | null;
  fetchedAt: string;
  tags: string[];
  license: InternetIntentLicense;
  author: InternetIntentAuthor;
  relevance: InternetIntentRelevance;
  reviewStatus: "unreviewed";
  repository: {
    fullName: string;
    defaultBranch: string;
    filePath: string;
  } | null;
}

export interface InternetIntentDuplicate {
  id: string;
  duplicateOf: string;
  similarity: number;
  reason: "exact" | "near";
}

export interface InternetIntentDeduplicationResult {
  kept: InternetIntentCandidate[];
  removed: InternetIntentDuplicate[];
}
