import { notFound, redirect } from "next/navigation";
import BacktestWorkspace from "../../../../backtest-workspace";
import { getMessages } from "../../../../i18n";
import { isLocale, localePath } from "../../../../i18n/locales";
import SignInGate from "../../../../sign-in-gate";
import Stepper from "../../../../stepper";
import { readStrategy } from "../../../../strategy-store";

export const dynamic = "force-dynamic";

export default async function BacktestPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getMessages(locale);
  const { session, strategy } = await readStrategy(id);
  if (!strategy) notFound();

  // The rules must be locked before any history is spent on them.
  if (!strategy.confirmedAt) redirect(localePath(locale, `/s/${id}/confirm`));

  const contract = strategy.result.contract as { timeframe?: string } | null;
  const timeframe = contract?.timeframe;
  if (!timeframe) redirect(localePath(locale, `/s/${id}/confirm`));

  const reached = strategy.hasOptimization ? "optimize" : "backtest";

  return (
    <>
      <Stepper locale={locale} state={{ current: "backtest", reached, strategyId: id }} />
      {session.user
        ? (
          <BacktestWorkspace
            locale={locale}
            step="backtest"
            strategyId={id}
            strategyName={strategy.title || String(strategy.result.strategyName ?? messages.strategies.untitled)}
            asset={strategy.asset}
            market={strategy.market}
            timeframe={timeframe}
          />
        )
        : <SignInGate locale={locale} messages={messages} returnTo={localePath(locale, `/s/${id}/backtest`)} />}
    </>
  );
}
