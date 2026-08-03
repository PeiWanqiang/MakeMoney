/**
 * Admission control for the expensive endpoints of the backtest API.
 *
 * What this does *not* do is worth stating first, because the obvious reading is
 * wrong: it cannot stop a backtest from blocking the event loop. The executor is
 * synchronous, so the runtime has already serialized it against everything else
 * — no semaphore can interleave what never yields. Wrapping the executor alone
 * would be pure ceremony.
 *
 * What it does bound is how many requests are in flight through the parts that
 * *do* yield. A backtest at the 10,000-bar cap holds the bars, an equity point
 * per bar and the trade ledger across every `await` in the handler — several
 * megabytes each, held for as long as the slowest archive download takes. It is
 * the count of those overlapping working sets, not the CPU, that decides whether
 * a small box degrades or falls over, and nothing else in the request path
 * bounds it.
 *
 * So the gate caps concurrent occupancy and the queue behind it. A caller
 * arriving past the queue limit is rejected immediately with a retry hint rather
 * than joining an unbounded line: a fast 429 is a better answer than a request
 * that holds a connection and its memory until something times out.
 *
 * The counter lives in the isolate, which is the scope that owns the memory it
 * protects. Per-user abuse limits are a separate concern and stay in the
 * database, where they can span isolates and outlive them.
 */

/** Thrown when the queue for a gate is full. Surfaces as 429 with `Retry-After`. */
export class BusyError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Server busy");
    this.name = "BusyError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Fields are declared and assigned rather than written as constructor parameter
 * properties: the latter is one of the few TypeScript constructs that cannot be
 * erased, and keeping this module type-strippable is what lets the tests import
 * it directly instead of through the bundle.
 */
export class ConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly maximumActive: number;
  private readonly maximumWaiting: number;
  private readonly retryAfterSeconds: number;

  constructor(maximumActive: number, maximumWaiting: number, retryAfterSeconds: number) {
    this.maximumActive = maximumActive;
    this.maximumWaiting = maximumWaiting;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** Current occupancy, for the performance block in API responses. */
  get load(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiting.length };
  }

  async run<T>(task: () => T | Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maximumActive) {
      this.active += 1;
      return;
    }
    if (this.waiting.length >= this.maximumWaiting) throw new BusyError(this.retryAfterSeconds);
    // `release` hands its slot straight over instead of decrementing, so the
    // count stays accurate across the handoff and no one can slip in between.
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }
}
