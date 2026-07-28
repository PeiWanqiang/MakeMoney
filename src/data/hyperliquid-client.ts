import type { MarketBar } from "../core/types.js";

export const HYPERLIQUID_INFO_ENDPOINT = "https://api.hyperliquid.xyz/info";
export const ONE_MINUTE_MS = 60_000;

interface HyperliquidCandleResponse {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
}

interface HyperliquidFundingResponse {
  coin: string;
  fundingRate: string;
  premium: string;
  time: number;
}

export interface NormalizedMarketBar extends MarketBar {
  endTimestamp: number;
  trades: number;
  fundingPremium: number;
}

export interface DataGap {
  afterTimestamp: number;
  expectedTimestamp: number;
  actualTimestamp: number;
  missingBars: number;
}

export interface MarketDataQuality {
  duplicateCandles: number;
  invalidCandles: number;
  gaps: DataGap[];
  fundingEvents: number;
}

export interface DownloadedMarketData {
  coin: string;
  interval: "1m";
  intervalMs: number;
  requestedStart: number;
  requestedEnd: number;
  bars: NormalizedMarketBar[];
  quality: MarketDataQuality;
}

export interface HyperliquidClientOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  retries?: number;
  maxFundingPerRequest?: number;
}

function finiteNumber(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Hyperliquid returned a non-finite ${field}.`);
  return parsed;
}

function isCandle(value: unknown): value is HyperliquidCandleResponse {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.t === "number" &&
    typeof row.T === "number" &&
    typeof row.s === "string" &&
    row.i === "1m" &&
    typeof row.o === "string" &&
    typeof row.c === "string" &&
    typeof row.h === "string" &&
    typeof row.l === "string" &&
    typeof row.v === "string" &&
    typeof row.n === "number"
  );
}

function isFunding(value: unknown): value is HyperliquidFundingResponse {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.coin === "string" &&
    typeof row.fundingRate === "string" &&
    typeof row.premium === "string" &&
    typeof row.time === "number"
  );
}

export class HyperliquidClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly retries: number;
  private readonly maxFundingPerRequest: number;

  constructor(options: HyperliquidClientOptions = {}) {
    this.endpoint = options.endpoint ?? HYPERLIQUID_INFO_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.retries = options.retries ?? 3;
    this.maxFundingPerRequest = options.maxFundingPerRequest ?? 500;
  }

  private async post<T>(body: Record<string, unknown>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Hyperliquid request failed with HTTP ${response.status}.`);
        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
        if (attempt === this.retries) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Hyperliquid request failed.");
  }

  private async downloadFunding(coin: string, startTime: number, endTime: number): Promise<HyperliquidFundingResponse[]> {
    const rows: HyperliquidFundingResponse[] = [];
    let cursor = startTime;
    while (cursor <= endTime) {
      const response = await this.post<unknown>({ type: "fundingHistory", coin, startTime: cursor, endTime });
      if (!Array.isArray(response)) throw new Error("Hyperliquid funding response must be an array.");
      const page = response.filter(isFunding).sort((a, b) => a.time - b.time);
      rows.push(...page);
      const last = page.at(-1);
      if (!last || page.length < this.maxFundingPerRequest || last.time >= endTime) break;
      const nextCursor = last.time + 1;
      if (nextCursor <= cursor) break;
      cursor = nextCursor;
    }
    return rows;
  }

  async downloadOneMinuteMarketData(coin: string, startTime: number, endTime: number): Promise<DownloadedMarketData> {
    if (!Number.isInteger(startTime) || !Number.isInteger(endTime) || startTime >= endTime) {
      throw new Error("startTime and endTime must be integer epoch milliseconds with startTime < endTime.");
    }
    const normalizedCoin = coin.trim().toUpperCase();
    if (!/^[A-Z0-9:_-]{1,32}$/.test(normalizedCoin)) throw new Error("coin contains unsupported characters.");

    const alignedStart = Math.floor(startTime / ONE_MINUTE_MS) * ONE_MINUTE_MS;
    const alignedEnd = Math.floor(endTime / ONE_MINUTE_MS) * ONE_MINUTE_MS + ONE_MINUTE_MS - 1;
    const [candleResponse, fundingRows] = await Promise.all([
      this.post<unknown>({
        type: "candleSnapshot",
        req: { coin: normalizedCoin, interval: "1m", startTime: alignedStart, endTime: alignedEnd },
      }),
      this.downloadFunding(normalizedCoin, alignedStart, alignedEnd),
    ]);
    if (!Array.isArray(candleResponse)) throw new Error("Hyperliquid candle response must be an array.");

    const uniqueCandles = new Map<number, HyperliquidCandleResponse>();
    let duplicateCandles = 0;
    let invalidCandles = 0;
    for (const value of candleResponse) {
      if (!isCandle(value) || value.s !== normalizedCoin || value.t < alignedStart || value.t > alignedEnd) {
        invalidCandles += 1;
        continue;
      }
      if (uniqueCandles.has(value.t)) duplicateCandles += 1;
      uniqueCandles.set(value.t, value);
    }

    const funding = fundingRows
      .filter((row) => row.coin === normalizedCoin && row.time >= alignedStart && row.time <= alignedEnd)
      .map((row) => ({
        time: row.time,
        rate: finiteNumber(row.fundingRate, "fundingRate"),
        premium: finiteNumber(row.premium, "funding premium"),
      }))
      .sort((a, b) => a.time - b.time);

    let fundingIndex = 0;
    const bars: NormalizedMarketBar[] = [];
    for (const candle of [...uniqueCandles.values()].sort((a, b) => a.t - b.t)) {
      const open = finiteNumber(candle.o, "open");
      const high = finiteNumber(candle.h, "high");
      const low = finiteNumber(candle.l, "low");
      const close = finiteNumber(candle.c, "close");
      const volume = finiteNumber(candle.v, "volume");
      if (high < Math.max(open, close) || low > Math.min(open, close) || low > high || volume < 0 || candle.n < 0) {
        invalidCandles += 1;
        continue;
      }

      let fundingRate = 0;
      let fundingPremium = 0;
      while (fundingIndex < funding.length && (funding[fundingIndex]?.time ?? Infinity) < candle.t) fundingIndex += 1;
      let scanIndex = fundingIndex;
      while (scanIndex < funding.length && (funding[scanIndex]?.time ?? Infinity) <= candle.T) {
        const event = funding[scanIndex];
        if (event) {
          fundingRate += event.rate;
          fundingPremium += event.premium;
        }
        scanIndex += 1;
      }
      fundingIndex = scanIndex;

      bars.push({
        timestamp: candle.t,
        endTimestamp: candle.T,
        open,
        high,
        low,
        close,
        volume,
        trades: candle.n,
        fundingRate,
        fundingPremium,
      });
    }

    const gaps: DataGap[] = [];
    for (let index = 1; index < bars.length; index += 1) {
      const previous = bars[index - 1];
      const current = bars[index];
      if (!previous || !current) continue;
      const expectedTimestamp = previous.timestamp + ONE_MINUTE_MS;
      if (current.timestamp !== expectedTimestamp) {
        gaps.push({
          afterTimestamp: previous.timestamp,
          expectedTimestamp,
          actualTimestamp: current.timestamp,
          missingBars: Math.max(0, Math.round((current.timestamp - expectedTimestamp) / ONE_MINUTE_MS)),
        });
      }
    }

    return {
      coin: normalizedCoin,
      interval: "1m",
      intervalMs: ONE_MINUTE_MS,
      requestedStart: alignedStart,
      requestedEnd: alignedEnd,
      bars,
      quality: { duplicateCandles, invalidCandles, gaps, fundingEvents: funding.length },
    };
  }
}

