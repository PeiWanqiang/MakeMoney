import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { describeApiFailure } from "../app/api-error.ts";
import { en } from "../app/i18n/en.ts";
import { zh } from "../app/i18n/zh.ts";

const root = new URL("../", import.meta.url);

test("renders a server error code in the reader's language", () => {
  assert.equal(describeApiFailure(zh, { code: "COMPILE_FAILED" }, "fallback"), zh.errors.COMPILE_FAILED);
  assert.equal(describeApiFailure(en, { code: "STRATEGY_VERIFY_UNAVAILABLE" }, "fallback"), en.errors.STRATEGY_VERIFY_UNAVAILABLE);
  assert.equal(
    describeApiFailure(zh, { code: "RANGE_TOO_LARGE", params: { timeframe: "1h", maxBars: "10,000" } }, "fallback"),
    zh.errors.RANGE_TOO_LARGE("1h", "10,000"),
  );
});

test("falls back only when the code has no message yet", () => {
  assert.equal(describeApiFailure(zh, { code: "NOT_A_REAL_CODE" }, "fallback"), "fallback");
  assert.equal(describeApiFailure(zh, {}, "fallback"), "fallback");
});

// Every analyze failure used to collapse into one sentence here, because the
// clarification round read the server's `code` and never looked it up. A
// verify-gate rejection and an hourly rate limit both read as "analysis failed,
// please retry" — advice that is wrong for one and useless for the other.
test("every screen resolves API failures through the shared helper", async () => {
  const screens = ["app/understanding-panel.tsx", "app/strategy-composer.tsx", "app/backtest-workspace.tsx"];
  for (const screen of screens) {
    const contents = await readFile(new URL(screen, root), "utf8");
    assert.match(contents, /describeApiFailure/, `${screen} must resolve error codes through the shared helper`);
  }
});

test("both catalogues carry a message for every blocking API code", () => {
  const required = [
    "ANALYZE_FAILED", "BACKTEST_FAILED", "COMPILE_FAILED", "SOURCE_MISSING", "BACKTEST_SERVICE_ERROR",
    "NOT_RUNNABLE", "NOT_CONFIRMED", "STRATEGY_VERIFY_FAILED", "STRATEGY_VERIFY_UNAVAILABLE",
    "RATE_LIMITED", "AUTH_REQUIRED", "INTERNAL_ERROR", "MODEL_UNAVAILABLE", "EMPTY_MODEL_RESULT",
  ];
  for (const code of required) {
    assert.ok(zh.errors[code], `zh is missing a message for ${code}`);
    assert.ok(en.errors[code], `en is missing a message for ${code}`);
  }
});
