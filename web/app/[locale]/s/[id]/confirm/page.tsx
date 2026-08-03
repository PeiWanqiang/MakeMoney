import { notFound } from "next/navigation";
import { getMessages } from "../../../../i18n";
import { isLocale } from "../../../../i18n/locales";
import Stepper from "../../../../stepper";
import { readStrategy } from "../../../../strategy-store";
import UnderstandingPanel, { type StrategyArtifact } from "../../../../understanding-panel";

export const dynamic = "force-dynamic";

export default async function ConfirmPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getMessages(locale);
  const { session, strategy } = await readStrategy(id);
  if (!strategy) notFound();

  const artifact = strategy.result as unknown as StrategyArtifact;
  const reached = strategy.hasOptimization ? "optimize" : strategy.hasBacktest ? "backtest" : strategy.confirmedAt ? "backtest" : "confirm";

  return (
    <>
      <Stepper locale={locale} state={{ current: "confirm", reached, strategyId: id }} />
      <section className="step-section shell" id="main">
        <header className="step-head">
          <p className="step-badge">{messages.confirm.badge}</p>
          <h2>{messages.confirm.title[artifact.status] ?? messages.confirm.title.ready}</h2>
          <p className="step-why">{messages.confirm.whyThisStep}</p>
        </header>
        <UnderstandingPanel
          key={id}
          locale={locale}
          strategyId={id}
          intent={strategy.intent}
          asset={strategy.asset}
          market={strategy.market}
          artifact={artifact}
          confirmed={Boolean(strategy.confirmedAt)}
          signedIn={Boolean(session.user)}
        />
      </section>
    </>
  );
}
