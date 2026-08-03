/**
 * Locale primitives shared by the Worker, server components and client components.
 *
 * The locale always comes from the first path segment. The Worker derives it once
 * per request and injects it as a header so the root layout can set `<html lang>`
 * without reading route params; page components read the same value from
 * `params.locale`. Both paths resolve to the same string because both are derived
 * from the pathname.
 */

export const LOCALES = ["zh", "en"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "zh";

/** BCP 47 tags used for `<html lang>`, `Intl` formatting and model output requests. */
export const LOCALE_TAG: Record<Locale, string> = { zh: "zh-CN", en: "en" };

export const LOCALE_LABEL: Record<Locale, string> = { zh: "中文", en: "English" };

export function isLocale(value: string | undefined | null): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Returns the locale segment of a pathname, or null when the path is not localised. */
export function localeFromPathname(pathname: string): Locale | null {
  const segment = pathname.split("/")[1];
  return isLocale(segment) ? segment : null;
}

/** Strips the locale prefix so a path can be re-prefixed with another locale. */
export function pathnameWithoutLocale(pathname: string): string {
  const locale = localeFromPathname(pathname);
  if (!locale) return pathname === "" ? "/" : pathname;
  const rest = pathname.slice(locale.length + 1);
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/** Builds a localised href; `path` is always the locale-free application path. */
export function localePath(locale: Locale, path = "/"): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized === "/" ? `/${locale}` : `/${locale}${normalized}`;
}

/**
 * Picks the best supported locale from an `Accept-Language` header.
 * Quality values are honoured so `zh;q=0.4, en;q=0.9` resolves to English.
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const ranked = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...parameters] = part.trim().split(";");
      const quality = parameters
        .map((parameter) => /^\s*q=([\d.]+)\s*$/.exec(parameter))
        .find(Boolean);
      return { tag: (tag ?? "").trim().toLowerCase(), quality: quality ? Number(quality[1]) : 1 };
    })
    .filter((entry) => entry.tag && Number.isFinite(entry.quality))
    .sort((left, right) => right.quality - left.quality);

  for (const { tag } of ranked) {
    const base = tag.split("-")[0];
    if (base === "zh") return "zh";
    if (base === "en") return "en";
  }
  return DEFAULT_LOCALE;
}
