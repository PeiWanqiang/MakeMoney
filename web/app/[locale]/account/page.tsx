import { notFound } from "next/navigation";
import { getMessages } from "../../i18n";
import { isLocale, LOCALE_LABEL, localePath } from "../../i18n/locales";
import { getSession, signOutPath } from "../../session";
import SignInGate from "../../sign-in-gate";

export const dynamic = "force-dynamic";

export default async function AccountPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getMessages(locale);
  const session = await getSession();

  if (!session.user) {
    return <SignInGate locale={locale} messages={messages} returnTo={localePath(locale, "/account")} />;
  }

  return (
    <section className="step-section shell" id="main">
      <header className="step-head">
        <h2>{messages.account.title}</h2>
        <p>{messages.account.lede}</p>
      </header>

      <div className="panel account-panel">
        <dl>
          <div><dt>{messages.account.displayName}</dt><dd>{session.user.displayName}</dd></div>
          <div><dt>{messages.account.email}</dt><dd>{session.user.email}</dd></div>
          <div><dt>{messages.account.language}</dt><dd>{LOCALE_LABEL[locale]}</dd></div>
        </dl>
        <p className="side-note">{messages.account.languageNote}</p>
        <a className="ghost-button" href={signOutPath(localePath(locale))}>{messages.account.signOut}</a>
      </div>

      <div className="panel account-panel">
        <h3>{messages.account.dangerTitle}</h3>
        <p>{messages.account.dangerNote}</p>
      </div>
    </section>
  );
}
