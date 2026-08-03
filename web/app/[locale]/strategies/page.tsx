import Link from "next/link";
import { notFound } from "next/navigation";
import { getMessages } from "../../i18n";
import { isLocale, localePath } from "../../i18n/locales";
import SignInGate from "../../sign-in-gate";
import StrategyList from "../../strategy-list";
import { readMyStrategies } from "../../strategy-store";

export const dynamic = "force-dynamic";

export default async function StrategiesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getMessages(locale);
  const { session, strategies } = await readMyStrategies();

  if (!session.user) {
    return <SignInGate locale={locale} messages={messages} returnTo={localePath(locale, "/strategies")} />;
  }

  return (
    <section className="step-section shell" id="main">
      <header className="step-head with-action">
        <div>
          <h2>{messages.strategies.title}</h2>
          <p>{messages.strategies.lede}</p>
        </div>
        <Link className="ghost-button" href={localePath(locale, "/new")}>{messages.strategies.newStrategy}</Link>
      </header>
      <StrategyList locale={locale} strategies={strategies} />
    </section>
  );
}
