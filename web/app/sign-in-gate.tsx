import type { Messages } from "./i18n";
import { localePath, type Locale } from "./i18n/locales";

/**
 * The one place anonymous use stops. Steps 1 and 2 are open; verifying against
 * years of real klines costs real compute, so it needs an account — and having
 * one is also what stops the strategy from living on a single device.
 */
export default function SignInGate({
  locale, messages, returnTo,
}: {
  locale: Locale;
  messages: Messages;
  returnTo: string;
}) {
  return (
    <section className="step-section shell" id="main">
      <div className="panel signin-gate">
        <p className="panel-eyebrow">{messages.auth.required}</p>
        <h2>{messages.auth.signInTitle}</h2>
        <p>{messages.auth.requiredDetail}</p>
        <a className="primary-action" href={`/api/auth/google/start?return_to=${encodeURIComponent(returnTo)}`}>
          <span>{messages.auth.google}</span><b>→</b>
        </a>
        <p className="side-note">{messages.auth.signInLede}</p>
        <a className="ghost-link" href={localePath(locale, "/new")}>{messages.auth.orKeepTrying}</a>
      </div>
    </section>
  );
}
