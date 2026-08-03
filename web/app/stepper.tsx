import Link from "next/link";
import { getMessages } from "./i18n";
import { localePath, type Locale } from "./i18n/locales";

export type StepId = "compose" | "confirm" | "backtest" | "optimize";

const ORDER: StepId[] = ["compose", "confirm", "backtest", "optimize"];

export interface StepperState {
  /** The step being rendered right now. */
  current: StepId;
  /** The furthest step this strategy has actually reached. */
  reached: StepId;
  /** Present once a strategy exists; absent on the standalone compose route. */
  strategyId?: string;
}

function href(locale: Locale, step: StepId, strategyId: string | undefined): string | null {
  if (step === "compose") return localePath(locale, "/new");
  if (!strategyId) return null;
  return localePath(locale, `/s/${strategyId}/${step}`);
}

/**
 * The four-step bar doubles as navigation: finished steps link back to their own
 * route, so a customer can re-read what they confirmed without losing progress.
 * Steps beyond the furthest reached are inert — there is nothing to show yet.
 */
export default function Stepper({ locale, state }: { locale: Locale; state: StepperState }) {
  const messages = getMessages(locale);
  const currentIndex = ORDER.indexOf(state.current);
  const reachedIndex = ORDER.indexOf(state.reached);

  return (
    <div className="stepper-bar">
      <ol className="stepper shell" aria-label={messages.steps.ariaLabel}>
        {ORDER.map((step, index) => {
          const status = index < currentIndex && index <= reachedIndex
            ? "done"
            : index === currentIndex ? "active" : index <= reachedIndex ? "done" : "idle";
          const target = status === "active" ? null : status === "done" ? href(locale, step, state.strategyId) : null;
          const copy = messages.steps[step];
          const hint = status === "done"
            ? messages.steps.stateDone
            : status === "active" ? messages.steps.stateActive : copy.hint;
          const body = (
            <>
              <b>{status === "done" ? "✓" : index + 1}</b>
              <span>
                <strong>{copy.title}</strong>
                <small>{hint}</small>
              </span>
            </>
          );
          return (
            <li key={step} className={`stepper-item ${status}`} aria-current={status === "active" ? "step" : undefined}>
              {target
                ? <Link href={target} className="stepper-link" aria-label={messages.steps.backToStep(copy.title)}>{body}</Link>
                : body}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
