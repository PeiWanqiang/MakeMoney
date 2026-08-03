import { notFound, redirect } from "next/navigation";
import { isLocale, localePath } from "../../../i18n/locales";
import { readStrategy } from "../../../strategy-store";

export const dynamic = "force-dynamic";

/**
 * A bare strategy link resolves to wherever the work actually stopped, so
 * bookmarking `/s/<id>` always reopens the right step.
 */
export default async function StrategyEntryPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const { strategy } = await readStrategy(id);
  if (!strategy) notFound();

  if (strategy.hasOptimization) redirect(localePath(locale, `/s/${id}/optimize`));
  if (strategy.confirmedAt) redirect(localePath(locale, `/s/${id}/backtest`));
  redirect(localePath(locale, `/s/${id}/confirm`));
}
