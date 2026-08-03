import { notFound } from "next/navigation";
import { getMessages } from "../i18n";
import { isLocale, localePath } from "../i18n/locales";
import { getSession } from "../session";
import SiteHeader from "../site-header";

// Every page depends on per-request identity headers, so nothing here is static.
export const dynamic = "force-dynamic";

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getMessages(locale);
  const session = await getSession();

  return (
    <main>
      <a className="skip-link" href="#main">{messages.nav.skipToContent}</a>
      <SiteHeader locale={locale} user={session.user} />
      {children}
      <footer className="shell">
        <div className="brand"><span className="brand-mark">P/</span><span>{messages.brand.name}</span></div>
        <p>{messages.brand.disclaimer}</p>
        <a href={localePath(locale)}>{messages.brand.edition}</a>
      </footer>
    </main>
  );
}
