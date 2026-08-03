import { notFound, redirect } from "next/navigation";
import BacktestWorkspace, { type BacktestResult } from "../../../../backtest-workspace";
import { getMessages } from "../../../../i18n";
import { isLocale, localePath } from "../../../../i18n/locales";
import SignInGate from "../../../../sign-in-gate";
import Stepper from "../../../../stepper";
import { readLatestBacktest, readStrategy } from "../../../../strategy-store";

export const dynamic = "force-dynamic";

export default async function OptimizePage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getMessages(locale);
  const { session, strategy } = await readStrategy(id);
  if (!strategy) notFound();
  if (!strategy.confirmedAt) redirect(localePath(locale, `/s/${id}/confirm`));

  const contract = strategy.result.contract as { timeframe?: string } | null;
  const timeframe = contract?.timeframe;
  if (!timeframe) redirect(localePath(locale, `/s/${id}/confirm`));

  // Step 4 tunes against a run that already happened, so it is rehydrated from
  // the stored receipt rather than asking the customer to configure it twice.
  const latest = session.user ? await readLatestBacktest(id) : null;

  return (
    <>
      <Stepper locale={locale} state={{ current: "optimize", reached: "optimize", strategyId: id }} />
      {session.user
        ? (
          <BacktestWorkspace
            locale={locale}
            step="optimize"
            strategyId={id}
            strategyName={strategy.title || String(strategy.result.strategyName ?? messages.strategies.untitled)}
            asset={strategy.asset}
            market={strategy.market}
            timeframe={timeframe}
            initialResult={latest as BacktestResult | null}
          />
        )
        : <SignInGate locale={locale} messages={messages} returnTo={localePath(locale, `/s/${id}/optimize`)} />}
    </>
  );
}
