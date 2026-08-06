import type { CompiledStrategyProgram } from "../compiler/compile-strategy-source.js";
import type { BacktestConfig, MarketBar } from "../core/types.js";
import { runCompiledBacktest } from "../runtime/backtest.js";
import { calculateBacktestMetrics } from "../runtime/backtest-metrics.js";
import type { OptimizationMetrics } from "./optimization.js";

/**
 * Fans the parameter lab's backtests out across worker threads.
 *
 * Every window the lab evaluates is an independent simulation of one program
 * variant over a prefix of the same bar series, so the only thing a request has
 * to name is the source, how far to simulate and where scoring starts. The bars
 * themselves are handed to each worker once at start-up rather than travelling
 * with every task.
 *
 * Results are returned positionally and failures are reported by the lowest
 * failing index, so a parallel run and a sequential run cannot disagree about
 * which answer — or which error — belongs to which request.
 */

export interface WindowRequest {
  /**
   * Already compiled, so a variant is type-checked once on the main thread
   * instead of once per worker that happens to be handed one of its windows.
   */
  program: CompiledStrategyProgram;
  /** Exclusive end of the simulated bar prefix. */
  endIndex: number;
  /** Index of the first scored bar; null scores from the first simulated bar. */
  evaluationStartIndex: number | null;
  config: BacktestConfig;
}

export interface EvaluationPool {
  evaluate(requests: WindowRequest[]): Promise<OptimizationMetrics[]>;
  dispose(): Promise<void>;
  readonly workerCount: number;
}

/** The single place a request turns into a backtest, shared by both back ends. */
export async function evaluateWindow(bars: MarketBar[], request: WindowRequest): Promise<OptimizationMetrics> {
  const config: BacktestConfig = request.evaluationStartIndex === null
    ? request.config
    : { ...request.config, evaluationStartTime: bars[request.evaluationStartIndex]!.timestamp };
  const result = await runCompiledBacktest(request.program, bars.slice(0, request.endIndex), config);
  const metrics = calculateBacktestMetrics(result);
  return {
    netReturn: metrics.netReturn,
    maximumDrawdown: metrics.maximumDrawdown,
    sharpe: metrics.sharpe,
    winRate: metrics.winRate,
    profitFactor: metrics.profitFactor,
    tradeCount: metrics.tradeCount,
  };
}

interface WorkerReply {
  id: number;
  ok: boolean;
  metrics?: OptimizationMetrics;
  message?: string;
}

/**
 * Bounded because every worker loads its own copy of the TypeScript compiler and
 * its own QuickJS runtime; past a handful of threads the memory and start-up
 * cost outgrow what another core buys back.
 */
const MAXIMUM_WORKERS = 8;

function sequentialPool(bars: MarketBar[]): EvaluationPool {
  return {
    workerCount: 1,
    async evaluate(requests) {
      const results: OptimizationMetrics[] = [];
      for (const request of requests) results.push(await evaluateWindow(bars, request));
      return results;
    },
    async dispose() {},
  };
}

function workerEntryUrl(): URL {
  // Running from source under tsx resolves the sibling `.ts`; an emitted build
  // resolves the `.js` next to this module.
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./evaluation-worker${extension}`, import.meta.url);
}

/**
 * Starts a pool, or returns null when worker threads are unavailable — a browser
 * or edge runtime, or a bundle where the worker entry cannot be resolved. Every
 * worker has to report itself ready before the pool is used, because a module
 * that fails to load surfaces asynchronously as an `error` event rather than
 * throwing from the constructor.
 */
async function startWorkerPool(bars: MarketBar[], requested: number): Promise<EvaluationPool | null> {
  let Worker: typeof import("node:worker_threads").Worker;
  try {
    ({ Worker } = await import("node:worker_threads"));
  } catch {
    return null;
  }

  const size = Math.max(1, Math.min(requested, MAXIMUM_WORKERS));
  const url = workerEntryUrl();
  const workers: Array<InstanceType<typeof Worker>> = [];
  const terminateAll = async (): Promise<void> => {
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => undefined)));
  };

  try {
    // Deliberately left referenced: an unreferenced worker does not hold the
    // event loop open, and a caller awaiting a batch would let the process exit
    // before the replies arrive. Every pool is disposed from a `finally`.
    for (let index = 0; index < size; index += 1) workers.push(new Worker(url, { workerData: { bars } }));
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      const onMessage = (message: { ready?: boolean }): void => {
        if (!message?.ready) return;
        worker.off("message", onMessage);
        worker.off("error", reject);
        resolve();
      };
      worker.on("message", onMessage);
      worker.once("error", reject);
    })));
  } catch {
    await terminateAll();
    return null;
  }

  const evaluate = (requests: WindowRequest[]): Promise<OptimizationMetrics[]> => new Promise((resolve, reject) => {
    if (requests.length === 0) {
      resolve([]);
      return;
    }
    const results = new Array<OptimizationMetrics>(requests.length);
    const failures = new Map<number, string>();
    const detach: Array<() => void> = [];
    let dispatched = 0;
    let completed = 0;
    let aborted = false;

    const finish = (): void => {
      for (const off of detach) off();
      if (failures.size === 0) {
        resolve(results);
        return;
      }
      const first = [...failures.keys()].sort((left, right) => left - right)[0]!;
      reject(new Error(failures.get(first)!));
    };

    const fail = (error: unknown): void => {
      if (aborted) return;
      aborted = true;
      for (const off of detach) off();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    for (const worker of workers) {
      const dispatch = (): void => {
        if (aborted || dispatched >= requests.length) return;
        const id = dispatched;
        dispatched += 1;
        worker.postMessage({ id, request: requests[id]! });
      };
      const onMessage = (reply: WorkerReply): void => {
        if (aborted || typeof reply?.id !== "number") return;
        if (reply.ok && reply.metrics) results[reply.id] = reply.metrics;
        else failures.set(reply.id, reply.message ?? "回测执行失败");
        completed += 1;
        if (completed === requests.length) finish();
        else dispatch();
      };
      worker.on("message", onMessage);
      worker.on("error", fail);
      detach.push(() => {
        worker.off("message", onMessage);
        worker.off("error", fail);
      });
      dispatch();
    }
  });

  return { workerCount: workers.length, evaluate, dispose: terminateAll };
}

/**
 * Below this many simulated bars in a batch, starting threads costs more than it
 * saves: a pool takes around 200ms to come up, and a sweep this small finishes
 * in well under a second on one thread. The figure is a measured rule of thumb,
 * not a boundary anything depends on — either back end returns the same numbers.
 */
const PARALLEL_WORK_THRESHOLD = 20_000;

/**
 * Returns a pool sized to the work at hand, falling back to in-process
 * sequential evaluation for small batches and wherever worker threads are not
 * available. Both back ends run the identical `evaluateWindow`, so the choice
 * only affects timing.
 */
export async function createEvaluationPool(bars: MarketBar[], requests: WindowRequest[]): Promise<EvaluationPool> {
  if (requests.length <= 1) return sequentialPool(bars);
  const simulatedBars = requests.reduce((total, request) => total + request.endIndex, 0);
  if (simulatedBars < PARALLEL_WORK_THRESHOLD) return sequentialPool(bars);
  let parallelism = 1;
  try {
    const { availableParallelism } = await import("node:os");
    parallelism = availableParallelism();
  } catch {
    return sequentialPool(bars);
  }
  if (parallelism <= 1) return sequentialPool(bars);
  return (await startWorkerPool(bars, Math.min(requests.length, parallelism))) ?? sequentialPool(bars);
}
