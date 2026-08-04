/**
 * Cloudflare Worker entry point.
 *
 * Two things happen here before the App Router sees a request:
 *
 * 1. Locale routing. The locale is the first path segment; `/` negotiates one from
 *    `Accept-Language` and redirects. The resolved locale is injected as a trusted
 *    header so the root layout can set `<html lang>` without route params.
 * 2. Identity resolution. The session cookie is exchanged for a user once per
 *    request and injected as trusted headers, mirroring how the hosting platform
 *    supplies `oai-authenticated-user-*`.
 *
 * Client-supplied `x-prooftrade-*` headers are stripped before injection.
 * Without that, anyone could forge an identity by sending the header directly.
 */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { DEFAULT_LOCALE, isLocale, negotiateLocale } from "../app/i18n/locales";
import { handleBacktestApi } from "./backtest-api";
import { handleStrategyApi } from "./strategy-api";
import { handleAuthApi, resolveIdentity, type Identity } from "./auth";

interface Env {
  ASSETS: Fetcher;
  CACHE: R2Bucket;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_STRATEGY_MODEL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_TOKEN_PROXY_URL?: string;
  BACKTEST_SERVICE_URL?: string;
  BACKTEST_SHADOW_MODE?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const IDENTITY_HEADER_PREFIX = "x-prooftrade-";

/** Paths that must never be rewritten with a locale prefix. */
const LOCALE_EXEMPT_PREFIXES = [
  "/api/",
  "/_vinext/",
  "/_next/",
  "/prooftrade-data/",
  // Reserved by the hosting platform; the app must not answer or rewrite these.
  "/signin-with-chatgpt",
  "/signout-with-chatgpt",
  "/callback",
];

function isLocaleExempt(pathname: string): boolean {
  if (LOCALE_EXEMPT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) return true;
  // Static assets keep their own paths (favicon, og images, fonts, manifests).
  return /\.[a-z0-9]+$/i.test(pathname);
}

/** Rebuilds the request with trusted identity headers, dropping any the client sent. */
function withTrustedHeaders(request: Request, locale: string, identity: Identity): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith(IDENTITY_HEADER_PREFIX)) headers.delete(name);
  }
  headers.set(`${IDENTITY_HEADER_PREFIX}locale`, locale);
  headers.set(`${IDENTITY_HEADER_PREFIX}anon-id`, identity.anonId);
  if (identity.user) {
    headers.set(`${IDENTITY_HEADER_PREFIX}user-id`, identity.user.id);
    headers.set(`${IDENTITY_HEADER_PREFIX}user-email`, encodeURIComponent(identity.user.email));
    headers.set(`${IDENTITY_HEADER_PREFIX}user-name`, encodeURIComponent(identity.user.displayName));
    if (identity.user.avatarUrl) headers.set(`${IDENTITY_HEADER_PREFIX}user-avatar`, encodeURIComponent(identity.user.avatarUrl));
  }
  return new Request(request, { headers });
}

function withCookies(response: Response, cookies: string[]): Response {
  if (cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const identity = await resolveIdentity(request, env);

    const authResponse = await handleAuthApi(request, env, identity);
    if (authResponse) return withCookies(authResponse, identity.setCookies);

    const backtestResponse = await handleBacktestApi(request, env, identity);
    if (backtestResponse) return withCookies(backtestResponse, identity.setCookies);

    const apiResponse = await handleStrategyApi(request, env, identity);
    if (apiResponse) return withCookies(apiResponse, identity.setCookies);

    if (!isLocaleExempt(url.pathname)) {
      const segment = url.pathname.split("/")[1];
      if (!isLocale(segment)) {
        // Signed-in users keep the language they chose; everyone else negotiates.
        const preferred = identity.user && isLocale(identity.user.locale)
          ? identity.user.locale
          : negotiateLocale(request.headers.get("accept-language")) || DEFAULT_LOCALE;
        const target = new URL(url);
        target.pathname = `/${preferred}${url.pathname === "/" ? "" : url.pathname}`;
        return withCookies(
          new Response(null, { status: 307, headers: { location: `${target.pathname}${target.search}`, "cache-control": "no-store" } }),
          identity.setCookies,
        );
      }
      const response = await handler.fetch(withTrustedHeaders(request, segment, identity), env, ctx);
      return withCookies(response, identity.setCookies);
    }

    return handler.fetch(withTrustedHeaders(request, DEFAULT_LOCALE, identity), env, ctx);
  },
};

export default worker;
