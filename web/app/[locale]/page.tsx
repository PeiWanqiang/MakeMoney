import Link from "next/link";
import { notFound } from "next/navigation";
import { getMessages } from "../i18n";
import { isLocale, localePath } from "../i18n/locales";
import { getSession } from "../session";

export const dynamic = "force-dynamic";

/**
 * The landing page carries every piece of product explanation.
 *
 * Nothing here repeats inside the workspace: each step keeps a single sentence
 * about why it exists, and the full argument lives on this page only. That is
 * what stops step 1 from opening on an introduction instead of an input box.
 */
export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getMessages(locale);
  const { landing, auth } = messages;
  const session = await getSession();
  const startHref = localePath(locale, "/new");

  return (
    <div id="main">
      <section className="hero shell" id="top">
        <div className="hero-copy">
          <p className="kicker"><span>{landing.kicker}</span></p>
          <h1>{landing.headlineLead}<br /><em>{landing.headlineEmphasis}</em></h1>
          <p className="hero-lede">{landing.lede}</p>
          <div className="hero-actions">
            <Link className="primary" href={startHref}>{landing.primaryCta} <b>→</b></Link>
            {session.user
              ? <Link href={localePath(locale, "/strategies")}>{landing.resumeCta}</Link>
              : <a href="#proof">{landing.secondaryCta}</a>}
          </div>
          <div className="hero-points">
            {landing.points.map((point) => <span key={point}>{point}</span>)}
          </div>
          {!session.user && (
            <p className="hero-signin">
              <a href={`/api/auth/google/start?return_to=${encodeURIComponent(startHref)}`}>{auth.google}</a>
            </p>
          )}
        </div>

        <aside className="hero-journey" aria-label={landing.journeyTitle}>
          <div className="hero-journey-head">
            <span>{landing.journeyEyebrow}</span>
            <b>{landing.journeyTitle}</b>
          </div>
          {landing.journey.map((item, index) => (
            <article key={item.title}>
              <i>{index + 1}</i>
              <div><strong>{item.title}</strong><span>{item.detail}</span></div>
            </article>
          ))}
          <p className="hero-promise"><b>{landing.promiseLabel}</b><span>{landing.promiseBody}</span></p>
        </aside>
      </section>

      <section className="proof-section shell" id="proof">
        <div className="proof-intro">
          <p className="step-badge">{landing.proofBadge}</p>
          <h2>{landing.proofTitleLead}<br />{landing.proofTitleEmphasis}</h2>
          <p>{landing.proofLede}</p>
        </div>
        <div className="proof-steps">
          {landing.proof.map((item, index) => (
            <article key={item.title}>
              <b>{String(index + 1).padStart(2, "0")}</b>
              <span>{item.tag}</span>
              <h3>{item.title}</h3>
              <p>{item.detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="closing shell">
        <div>
          <p>{landing.closingEyebrow}</p>
          <h2>{landing.closingTitleLead}<br />{landing.closingTitleEmphasis}</h2>
        </div>
        <Link href={startHref}>{landing.closingCta} <span>↗</span></Link>
      </section>
    </div>
  );
}
