/**
 * Identity for ProofTrade: Google OAuth 2.0 (Authorization Code + PKCE) and
 * server-issued sessions.
 *
 * Two identities can be attached to a request:
 *
 * - `user`   — a signed-in account, resolved from the `pt_session` cookie.
 * - `anonId` — a server-issued anonymous workspace id (`pt_anon` cookie) that lets
 *              a visitor use the first two steps before signing in. On sign-in the
 *              records created under that id are claimed by the account.
 *
 * The browser never supplies either identity in a request body. Everything the
 * authorisation layer trusts is derived here, from cookies the server itself set.
 */

export interface AuthEnv {
  DB: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Dev-only: routes the token exchange through scripts/dev-google-proxy.mjs when direct access to Google is blocked. */
  GOOGLE_TOKEN_PROXY_URL?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  locale: string;
}

export interface Identity {
  user: AuthUser | null;
  /** Anonymous workspace id. Always present; issued on first request when missing. */
  anonId: string;
  /** Cookies the caller must attach to the response (anonymous id issuance). */
  setCookies: string[];
}

const SESSION_COOKIE = "pt_session";
const ANON_COOKIE = "pt_anon";
const OAUTH_COOKIE = "pt_oauth";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const OAUTH_TTL_SECONDS = 600;
const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CALLBACK_PATH = "/api/auth/google/callback";

let authSchemaReady: Promise<unknown> | null = null;

async function ensureAuthSchema(db: D1Database): Promise<void> {
  if (authSchemaReady) {
    await authSchemaReady;
    return;
  }
  authSchemaReady = db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      google_sub TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      display_name TEXT,
      avatar_url TEXT,
      locale TEXT NOT NULL DEFAULT 'zh',
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS users_email_idx ON users(email)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id, expires_at)"),
  ]).catch((error) => {
    authSchemaReady = null;
    throw error;
  });
  await authSchemaReady;
}

/* ---------- primitives ---------- */

function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeToString(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
  return base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]!.trim() === "https";
  return new URL(request.url).protocol === "https:";
}

function buildCookie(
  request: Request,
  name: string,
  value: string,
  options: { maxAge: number; httpOnly?: boolean; sameSite?: "Lax" | "Strict" },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${options.maxAge}`,
    `SameSite=${options.sameSite ?? "Lax"}`,
  ];
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (isSecureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(request: Request, name: string): string {
  return buildCookie(request, name, "", { maxAge: 0 });
}

/** Absolute callback URL derived from the incoming request, so dev and production never diverge. */
function callbackUrl(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const protocol = isSecureRequest(request) ? "https" : "http";
  return `${protocol}://${host}${CALLBACK_PATH}`;
}

/**
 * Accepts only same-origin relative paths, so a crafted `return_to` cannot bounce
 * a freshly signed-in user to another site.
 */
export function safeReturnPath(value: string | null | undefined, fallback = "/"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  let url: URL;
  try {
    url = new URL(value, "https://app.local");
  } catch {
    return fallback;
  }
  if (url.origin !== "https://app.local") return fallback;
  if (url.pathname.startsWith("/api/auth/")) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

/* ---------- session store ---------- */

async function createSession(db: D1Database, userId: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await db.prepare("INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(
      await sha256Hex(token),
      userId,
      new Date(now).toISOString(),
      new Date(now + SESSION_TTL_SECONDS * 1000).toISOString(),
    ).run();
  return token;
}

async function userForToken(db: D1Database, token: string): Promise<AuthUser | null> {
  const row = await db.prepare(`SELECT u.id, u.email, u.display_name, u.avatar_url, u.locale
      FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`)
    .bind(await sha256Hex(token), new Date().toISOString())
    .first<{ id: string; email: string; display_name: string | null; avatar_url: string | null; locale: string }>();
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name || row.email,
    avatarUrl: row.avatar_url,
    locale: row.locale,
  };
}

async function revokeSession(db: D1Database, token: string): Promise<void> {
  await db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(new Date().toISOString(), await sha256Hex(token)).run();
}

/* ---------- identity resolution ---------- */

/**
 * Resolves the identity of a request. Called once per request by the Worker entry
 * point; the result is injected into trusted headers for server components and
 * reused by the API handlers.
 */
export async function resolveIdentity(request: Request, env: AuthEnv): Promise<Identity> {
  const setCookies: string[] = [];
  let anonId = readCookie(request, ANON_COOKIE);
  if (!anonId || anonId.length < 16 || anonId.length > 96) {
    anonId = crypto.randomUUID();
    setCookies.push(buildCookie(request, ANON_COOKIE, anonId, { maxAge: 365 * 24 * 60 * 60 }));
  }

  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return { user: null, anonId, setCookies };

  try {
    await ensureAuthSchema(env.DB);
    return { user: await userForToken(env.DB, token), anonId, setCookies };
  } catch {
    return { user: null, anonId, setCookies };
  }
}

/* ---------- ownership claiming ---------- */

/**
 * Moves everything created under an anonymous workspace id into the account.
 * Only unowned rows are touched, so replaying a sign-in cannot steal records.
 */
async function claimAnonymousRecords(db: D1Database, anonId: string, userId: string): Promise<void> {
  const tables = ["strategy_submissions", "backtest_runs", "optimization_runs"];
  for (const table of tables) {
    await db.prepare(`UPDATE ${table} SET user_id = ? WHERE session_id = ? AND user_id IS NULL`)
      .bind(userId, anonId).run()
      .catch(() => undefined); // The table may not exist yet on a brand-new database.
  }
}

/* ---------- Google OAuth ---------- */

interface GoogleIdTokenClaims {
  iss?: string;
  aud?: string;
  exp?: number;
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

function decodeIdToken(idToken: string): GoogleIdTokenClaims | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(base64UrlDecodeToString(parts[1]!)) as GoogleIdTokenClaims;
  } catch {
    return null;
  }
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

async function startGoogleSignIn(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const returnTo = safeReturnPath(url.searchParams.get("return_to"));
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return redirect(`${returnTo.split("?")[0]}?auth_error=not_configured`);
  }

  const state = randomToken(16);
  const verifier = randomToken(48);
  const authorizeUrl = new URL(GOOGLE_AUTH_ENDPOINT);
  authorizeUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl(request));
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "openid email profile");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", await pkceChallenge(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("prompt", "select_account");

  const pending = buildCookie(request, OAUTH_COOKIE, JSON.stringify({ state, verifier, returnTo }), {
    maxAge: OAUTH_TTL_SECONDS,
  });
  return redirect(authorizeUrl.toString(), [pending]);
}

async function completeGoogleSignIn(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const pendingRaw = readCookie(request, OAUTH_COOKIE);
  const cleared = clearCookie(request, OAUTH_COOKIE);
  const failure = (returnTo: string, reason: string) => {
    console.error(`[auth] Google sign-in failed: ${reason}`);
    return redirect(`${returnTo.split("?")[0]}?auth_error=failed`, [cleared]);
  };

  if (!pendingRaw) return failure("/", "no pt_oauth cookie (expired, or oauth-google-start was never hit)");
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return failure("/", "GOOGLE_CLIENT_ID/SECRET missing from env");

  let pending: { state?: string; verifier?: string; returnTo?: string };
  try {
    pending = JSON.parse(pendingRaw) as typeof pending;
  } catch {
    return failure("/", "pt_oauth cookie was not valid JSON");
  }
  const returnTo = safeReturnPath(pending.returnTo);
  const code = url.searchParams.get("code");
  if (!code) return failure(returnTo, "no ?code= in callback URL");
  if (!pending.state || url.searchParams.get("state") !== pending.state) return failure(returnTo, "state mismatch");

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(env.GOOGLE_TOKEN_PROXY_URL || GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: callbackUrl(request),
        grant_type: "authorization_code",
        code_verifier: pending.verifier ?? "",
      }),
    });
  } catch (error) {
    // Network failure reaching Google (e.g. no route to accounts/oauth2.googleapis.com)
    // must not crash the request — surface it as a normal sign-in failure instead.
    return failure(returnTo, `token fetch threw: ${String(error)}`);
  }
  if (!tokenResponse.ok) {
    const body = await tokenResponse.text().catch(() => "<unreadable>");
    return failure(returnTo, `token endpoint returned ${tokenResponse.status}: ${body}`);
  }

  const tokens = await tokenResponse.json() as { id_token?: string };
  const claims = tokens.id_token ? decodeIdToken(tokens.id_token) : null;
  // The token endpoint answered over TLS directly, so the signature is already
  // covered by the channel (OIDC Core 3.1.3.7). Audience, issuer and expiry still
  // have to match, otherwise a token minted for another client would be accepted.
  if (
    !claims?.sub
    || !claims.email
    || !GOOGLE_ISSUERS.has(String(claims.iss))
    || claims.aud !== env.GOOGLE_CLIENT_ID
    || !claims.exp
    || claims.exp * 1000 <= Date.now()
  ) {
    return failure(returnTo, `id_token claims invalid: ${JSON.stringify(claims)}`);
  }

  await ensureAuthSchema(env.DB);
  const now = new Date().toISOString();
  const existing = await env.DB.prepare("SELECT id FROM users WHERE google_sub = ?")
    .bind(claims.sub).first<{ id: string }>();
  const userId = existing?.id ?? crypto.randomUUID();
  if (existing) {
    await env.DB.prepare("UPDATE users SET email = ?, email_verified = ?, display_name = ?, avatar_url = ?, last_seen_at = ? WHERE id = ?")
      .bind(claims.email, claims.email_verified ? 1 : 0, claims.name ?? null, claims.picture ?? null, now, userId).run();
  } else {
    await env.DB.prepare(`INSERT INTO users (id, google_sub, email, email_verified, display_name, avatar_url, locale, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        userId,
        claims.sub,
        claims.email,
        claims.email_verified ? 1 : 0,
        claims.name ?? null,
        claims.picture ?? null,
        returnTo.startsWith("/en") ? "en" : "zh",
        now,
        now,
      ).run();
  }

  const anonId = readCookie(request, ANON_COOKIE);
  if (anonId) await claimAnonymousRecords(env.DB, anonId, userId);

  const token = await createSession(env.DB, userId);
  return redirect(returnTo, [
    cleared,
    buildCookie(request, SESSION_COOKIE, token, { maxAge: SESSION_TTL_SECONDS }),
  ]);
}

async function signOut(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    await ensureAuthSchema(env.DB);
    await revokeSession(env.DB, token);
  }
  const returnTo = safeReturnPath(url.searchParams.get("return_to"));
  return redirect(returnTo, [clearCookie(request, SESSION_COOKIE)]);
}

/** Routes owned by the identity layer. Returns null when the path is not an auth route. */
export async function handleAuthApi(request: Request, env: AuthEnv, identity: Identity): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/api/auth/")) return null;

  if (pathname === "/api/auth/google/start" && request.method === "GET") return startGoogleSignIn(request, env);
  if (pathname === CALLBACK_PATH && request.method === "GET") return completeGoogleSignIn(request, env);
  if (pathname === "/api/auth/signout" && (request.method === "POST" || request.method === "GET")) return signOut(request, env);
  if (pathname === "/api/auth/locale" && request.method === "POST") {
    if (!identity.user) return Response.json({ error: "AUTH_REQUIRED", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = await request.json().catch(() => ({})) as { locale?: unknown };
    const locale = typeof body.locale === "string" ? body.locale : "";
    if (locale !== "zh" && locale !== "en") return Response.json({ error: "BAD_REQUEST", code: "BAD_REQUEST" }, { status: 400 });
    await updateUserLocale(env, identity.user.id, locale);
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  }
  if (pathname === "/api/auth/session" && request.method === "GET") {
    return Response.json(
      { user: identity.user, configured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) },
      { headers: { "cache-control": "no-store" } },
    );
  }
  return new Response("Not found", { status: 404 });
}

/** Locale preference persisted on the account, used when the UI language is switched. */
export async function updateUserLocale(env: AuthEnv, userId: string, locale: string): Promise<void> {
  await ensureAuthSchema(env.DB);
  await env.DB.prepare("UPDATE users SET locale = ?, last_seen_at = ? WHERE id = ?")
    .bind(locale, new Date().toISOString(), userId).run();
}
