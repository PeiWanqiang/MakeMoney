import { parentPort, workerData } from "node:worker_threads";

import type { MarketBar } from "../core/types.js";
import type { WindowRequest } from "./evaluation-pool.js";

/**
 * One evaluation worker. It receives the bar series once, through `workerData`,
 * and then answers one window request at a time — the pool never has more than a
 * single task in flight per worker, so two backtests can never interleave on the
 * same thread and double its memory.
 */

const port = parentPort;
if (!port) throw new Error("Evaluation worker must be started as a worker thread.");

/**
 * A worker thread does not inherit the module resolver the parent runs under:
 * Node applies `--import` per process rather than per thread, and its own type
 * stripping resolves `./x.js` literally instead of finding the `./x.ts` next to
 * it. So when this file is itself TypeScript — meaning the process is running
 * from source — the thread registers a resolver of its own first. A compiled
 * deployment has no loader to register and needs none, and a failure here simply
 * fails the thread, which the pool answers by falling back to sequential work.
 */
if (import.meta.url.endsWith(".ts")) {
  const { register } = await import("tsx/esm/api");
  register();
}

// Imported dynamically rather than statically: a static import is hoisted above
// the registration above, and would be resolved before the resolver exists.
const { evaluateWindow } = await import("./evaluation-pool.js");

const { bars } = workerData as { bars: MarketBar[] };

port.on("message", (task: { id: number; request: WindowRequest }) => {
  void evaluateWindow(bars, task.request).then(
    (metrics) => port.postMessage({ id: task.id, ok: true, metrics }),
    (error: unknown) => port.postMessage({
      id: task.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
});

port.postMessage({ ready: true });
