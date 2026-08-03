import { headers } from "next/headers";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./i18n/locales";

/**
 * Server-side view of the current visitor.
 *
 * The Worker entry point resolves identity once per request and injects it as
 * `x-prooftrade-*` headers after stripping any the client sent, so these values
 * are trusted here. Server components never parse cookies themselves.
 */

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface Session {
  user: SessionUser | null;
  anonId: string;
  locale: Locale;
}

function decode(value: string | null): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function getSession(): Promise<Session> {
  const requestHeaders = await headers();
  const locale = requestHeaders.get("x-prooftrade-locale");
  const id = requestHeaders.get("x-prooftrade-user-id");
  const email = decode(requestHeaders.get("x-prooftrade-user-email"));

  return {
    user: id && email
      ? {
        id,
        email,
        displayName: decode(requestHeaders.get("x-prooftrade-user-name")) || email,
        avatarUrl: decode(requestHeaders.get("x-prooftrade-user-avatar")),
      }
      : null,
    anonId: requestHeaders.get("x-prooftrade-anon-id") ?? "",
    locale: isLocale(locale) ? locale : DEFAULT_LOCALE,
  };
}

/** Sign-in URL that returns the visitor to where they were. */
export function signInPath(returnTo: string): string {
  return `/api/auth/google/start?return_to=${encodeURIComponent(returnTo)}`;
}

export function signOutPath(returnTo: string): string {
  return `/api/auth/signout?return_to=${encodeURIComponent(returnTo)}`;
}
