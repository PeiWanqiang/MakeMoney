import type { Metadata } from "next";
import { IBM_Plex_Mono, Noto_Sans_SC } from "next/font/google";
import { headers } from "next/headers";
import { getMessages } from "./i18n";
import { DEFAULT_LOCALE, isLocale, LOCALE_TAG } from "./i18n/locales";
import "./globals.css";

const sans = Noto_Sans_SC({ variable: "--font-sans", subsets: ["latin"], weight: ["400", "500", "600", "700", "900"] });
const mono = IBM_Plex_Mono({ variable: "--font-mono", subsets: ["latin"], weight: ["400", "500", "600"] });

/**
 * The root layout owns `<html>`, so it cannot read the `[locale]` route param.
 * The Worker resolves the locale from the pathname and injects it as a trusted
 * header, which is the same value `params.locale` carries further down the tree.
 */
async function requestLocale() {
  const requestHeaders = await headers();
  const value = requestHeaders.get("x-prooftrade-locale");
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const locale = await requestLocale();
  const messages = getMessages(locale);
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og-customer-journey.png`;
  const title = `${messages.brand.name} — ${messages.brand.tagline}`;
  return {
    title,
    description: messages.landing.lede,
    alternates: { languages: { "zh-CN": "/zh", en: "/en" } },
    openGraph: {
      title: messages.brand.name,
      description: messages.brand.tagline,
      locale: LOCALE_TAG[locale],
      images: [{ url: image, width: 1200, height: 630 }],
    },
    twitter: { card: "summary_large_image", title: messages.brand.name, description: messages.brand.tagline, images: [image] },
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await requestLocale();
  return (
    <html lang={LOCALE_TAG[locale]}>
      <body className={`${sans.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
