import type { Messages } from "./i18n";

/** The error envelope every API route returns: a stable code plus optional interpolation values. */
export interface ApiErrorPayload {
  code?: string;
  params?: Record<string, string | number>;
}

/**
 * Renders an API failure in the reader's language.
 *
 * Every route already answers with a stable `code`; the value of that only
 * reaches the customer if the call site actually looks it up. Three screens had
 * three copies of this lookup and the clarification round had none at all, so a
 * verify-gate outage and an hourly rate limit both surfaced as the same
 * "analysis failed, please retry" — advice that is wrong for one of them and
 * useless for the other. One helper, used everywhere, is what keeps a code the
 * server took the trouble to choose from being thrown away at the last step.
 *
 * `fallback` covers codes with no message yet, so a new server-side code degrades
 * to a generic sentence rather than a blank error.
 */
export function describeApiFailure(messages: Messages, payload: ApiErrorPayload, fallback: string): string {
  const entry = payload.code ? (messages.errors as Record<string, unknown>)[payload.code] : undefined;
  if (typeof entry === "function") {
    const values = payload.params ?? {};
    return (entry as (timeframe: string, maxBars: string) => string)(
      String(values.timeframe ?? ""),
      String(values.maxBars ?? ""),
    );
  }
  return typeof entry === "string" ? entry : fallback;
}
