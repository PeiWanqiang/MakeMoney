import { loadLatestBacktest } from "../worker/backtest-api";
import { listStrategies, loadStrategy, type StoredStrategy, type StrategyListItem } from "../worker/strategy-api";
import { getSession, type Session } from "./session";

/**
 * Server-component access to stored strategies.
 *
 * The stepped routes are server-rendered, so progress survives a refresh and a
 * shared link resolves to the same strategy. Reads go through the same ownership
 * predicate the APIs use — identity comes from the session headers the Worker
 * injected, never from anything in the URL.
 */

/**
 * The D1 binding is resolved lazily. A static `cloudflare:workers` import would
 * be hoisted into the server bundle's entry, which makes the bundle unloadable
 * outside the Workers runtime — including in the render tests.
 */
async function database(): Promise<D1Database | undefined> {
  const { env } = await import("cloudflare:workers");
  return env.DB;
}

function identityFor(session: Session) {
  return {
    user: session.user
      ? { id: session.user.id, email: session.user.email, displayName: session.user.displayName, avatarUrl: session.user.avatarUrl, locale: "" }
      : null,
    anonId: session.anonId,
    setCookies: [],
  };
}

export async function readStrategy(id: string): Promise<{ session: Session; strategy: StoredStrategy | null }> {
  const session = await getSession();
  const db = await database();
  if (!db) return { session, strategy: null };
  return { session, strategy: await loadStrategy(db, identityFor(session), id) };
}

export async function readLatestBacktest(id: string): Promise<Record<string, unknown> | null> {
  const session = await getSession();
  const db = await database();
  if (!db) return null;
  return loadLatestBacktest(db, identityFor(session), id);
}

export async function readMyStrategies(): Promise<{ session: Session; strategies: StrategyListItem[] }> {
  const session = await getSession();
  const db = await database();
  if (!session.user || !db) return { session, strategies: [] };
  return { session, strategies: await listStrategies(db, session.user.id) };
}

export type { StoredStrategy, StrategyListItem };
