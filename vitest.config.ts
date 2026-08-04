import { defineConfig } from "vitest/config";

// Root test suite covers the engine (test/*.test.ts). The independent `web/`
// repository runs its own node:test suite (`web/tests/*.mjs`) and must not be
// discovered here; it is not part of this package's vitest graph.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/web/**"],
  },
});
