import { defineConfig } from "vitest/config";

// Root test suite covers the engine (test/*.test.ts). The independent `web/`
// repository runs its own node:test suite (`web/tests/*.mjs`) and must not be
// discovered here; it is not part of this package's vitest graph.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/web/**"],
    // Semantic verification boots a QuickJS/WASM sandbox per scenario, and the
    // files run in parallel, so the default 5s is short enough that a loaded
    // machine fails a test that is only slow. The budget is for scheduling
    // noise, not for a hang: a real one still stops the run well inside it.
    testTimeout: 30_000,
  },
});
