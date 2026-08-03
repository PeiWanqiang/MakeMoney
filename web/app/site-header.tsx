"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { getMessages } from "./i18n";
import { localePath, LOCALE_LABEL, LOCALES, pathnameWithoutLocale, type Locale } from "./i18n/locales";
import type { SessionUser } from "./session";

interface Props {
  locale: Locale;
  user: SessionUser | null;
}

/**
 * Global chrome: brand, primary navigation, language switcher and identity.
 *
 * The language switcher swaps the locale prefix on the current path so the
 * customer stays on the page they were reading, and persists the choice on the
 * account when there is one.
 */
export default function SiteHeader({ locale, user }: Props) {
  // The catalogue is derived from the locale here rather than passed in: message
  // values include formatting functions, which cannot cross the server/client
  // boundary. The locale string can.
  const messages = getMessages(locale);
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const bare = pathnameWithoutLocale(pathname);
  const returnTo = localePath(locale, bare);

  async function switchLocale(next: Locale) {
    if (next === locale) return;
    if (user) {
      await fetch("/api/auth/locale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale: next }),
      }).catch(() => undefined);
    }
    router.push(localePath(next, bare));
  }

  return (
    <nav className="nav shell" aria-label={messages.nav.primaryLabel}>
      <Link className="brand" href={localePath(locale)} aria-label={messages.brand.name}>
        <span className="brand-mark">P/</span>
        <span>{messages.brand.name}</span>
        <small>{messages.brand.tagline}</small>
      </Link>

      <div className="nav-links">
        <Link href={localePath(locale, "/new")}>{messages.nav.start}</Link>
        {user && <Link href={localePath(locale, "/strategies")}>{messages.nav.myStrategies}</Link>}

        <div className="locale-switch" role="group" aria-label={messages.nav.languageLabel}>
          {LOCALES.map((option) => (
            <button
              key={option}
              className={option === locale ? "active" : ""}
              aria-current={option === locale ? "true" : undefined}
              onClick={() => void switchLocale(option)}
            >
              {LOCALE_LABEL[option]}
            </button>
          ))}
        </div>

        {user
          ? (
            <div className="account-menu">
              <button className="account-trigger" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen}>
                <span>{user.displayName}</span>
              </button>
              {menuOpen && (
                <div className="account-dropdown">
                  <Link href={localePath(locale, "/account")} onClick={() => setMenuOpen(false)}>{messages.nav.account}</Link>
                  <a href={`/api/auth/signout?return_to=${encodeURIComponent(localePath(locale))}`}>{messages.nav.signOut}</a>
                </div>
              )}
            </div>
          )
          : (
            <a className="nav-signin" href={`/api/auth/google/start?return_to=${encodeURIComponent(returnTo)}`}>
              {messages.nav.signIn}
            </a>
          )}
      </div>
    </nav>
  );
}
