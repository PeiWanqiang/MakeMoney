import { en } from "./en";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./locales";
import { zh, type Messages } from "./zh";

const CATALOGUES: Record<Locale, Messages> = { zh, en };

/** Messages for a locale; unknown values fall back to the default catalogue. */
export function getMessages(locale: string | undefined | null): Messages {
  return CATALOGUES[isLocale(locale) ? locale : DEFAULT_LOCALE];
}

export type { Messages };
export * from "./locales";
