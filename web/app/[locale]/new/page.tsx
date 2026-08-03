import { notFound } from "next/navigation";
import { getMessages } from "../../i18n";
import { isLocale } from "../../i18n/locales";
import Stepper from "../../stepper";
import StrategyComposer from "../../strategy-composer";

export const dynamic = "force-dynamic";

export default async function ComposePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getMessages(locale);

  return (
    <>
      <Stepper locale={locale} state={{ current: "compose", reached: "compose" }} />
      <section className="step-section shell" id="main">
        <header className="step-head">
          <p className="step-badge">{messages.compose.badge}</p>
          <h2>{messages.compose.title}</h2>
          <p>{messages.compose.lede}</p>
          <p className="step-why">{messages.compose.whyThisStep}</p>
        </header>
        <StrategyComposer locale={locale} />
      </section>
    </>
  );
}
