"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { getMessages } from "./i18n";
import { localePath, type Locale } from "./i18n/locales";

interface Props {
  locale: Locale;
}

interface AnalyzeResponse {
  id?: string;
  code?: string;
  params?: Record<string, string | number>;
}

const ASSETS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const MARKETS = ["Binance Perpetual", "Binance Spot"];

/**
 * Step 1. The route opens directly on this input — every explanation of what the
 * product does lives on the landing page, and only the one sentence about why
 * this step exists is repeated here.
 *
 * On success the strategy already exists server-side, so navigation to step 2 is
 * a real route change: reloading or sharing that URL resumes the same strategy.
 */
export default function StrategyComposer({ locale }: Props) {
  const { compose, errors } = getMessages(locale);
  const router = useRouter();
  const [intent, setIntent] = useState("");
  const [asset, setAsset] = useState(ASSETS[0]!);
  const [market, setMarket] = useState(MARKETS[0]!);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function messageForCode(payload: AnalyzeResponse): string {
    const code = payload.code as keyof typeof errors | undefined;
    const entry = code ? errors[code] : undefined;
    if (typeof entry === "function") {
      const values = payload.params ?? {};
      return entry(String(values.timeframe ?? ""), String(values.maxBars ?? ""));
    }
    return typeof entry === "string" ? entry : errors.ANALYZE_FAILED;
  }

  async function analyze() {
    const submitted = intent.trim();
    if (submitted.length < 12 || loading) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/strategy/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: submitted, asset, market, locale }),
      });
      const payload = await response.json() as AnalyzeResponse;
      if (!response.ok || !payload.id) throw new Error(messageForCode(payload));
      router.push(localePath(locale, `/s/${payload.id}/confirm`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : errors.ANALYZE_FAILED);
      setLoading(false);
    }
  }

  return (
    <div className="describe-grid">
      <div className="panel input-panel">
        <div className="market-row">
          <label>
            <span>{compose.assetLabel}</span>
            <select value={asset} onChange={(event) => setAsset(event.target.value)}>
              {ASSETS.map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
          <label>
            <span>{compose.marketLabel}</span>
            <select value={market} onChange={(event) => setMarket(event.target.value)}>
              {MARKETS.map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
          <p className="market-note">{compose.marketNote}</p>
        </div>

        <div className="intent-block">
          <label className="intent-label" htmlFor="intent">
            {compose.intentLabel}<small>{compose.intentLabelHint}</small>
          </label>
          <ul className="intent-prompts" aria-label={compose.promptsLabel}>
            {compose.prompts.map((prompt) => (
              <li key={prompt.term}><b>{prompt.term}</b>{prompt.detail}</li>
            ))}
          </ul>
          <textarea
            id="intent"
            value={intent}
            onChange={(event) => setIntent(event.target.value.slice(0, 5000))}
            aria-label={compose.textareaLabel}
            placeholder={compose.placeholder}
          />
          <div className="textarea-meta">
            <span>{compose.characterCount(intent.length)}</span>
            <span>{compose.languageNote}</span>
          </div>
        </div>

        {error && <div className="alert error" role="alert"><strong>{compose.failed}</strong><span>{error}</span></div>}

        <button className="primary-action" onClick={() => void analyze()} disabled={loading || intent.trim().length < 12}>
          <span>{loading ? compose.submitting : compose.submit}</span>
          <b>{loading ? <i className="spinner" /> : "→"}</b>
        </button>
        {intent.trim().length < 12 && (
          <p className="input-hint">{intent.trim().length === 0 ? compose.hintEmpty : compose.hintTooShort}</p>
        )}

        <div className="example-block">
          <p className="example-lead">{compose.exampleLead}</p>
          <div className="example-cards">
            {compose.examples.map((example, index) => (
              <button
                key={example.label}
                className={`example-card ${["ready", "question", "boundary"][index] ?? "ready"}`}
                onClick={() => { setIntent(example.text); setError(""); }}
              >
                <span className="example-tag"><i />{example.label}</span>
                <strong>{example.headline}</strong>
                <small>{example.hint}</small>
              </button>
            ))}
          </div>
        </div>

        <p className="privacy-note">{compose.privacyNote}</p>
      </div>

      <div className={`panel result-panel ${loading ? "is-loading" : ""}`} aria-live="polite">
        {loading
          ? (
            <div className="result-loading" role="status">
              <div className="scan-line" />
              <p className="panel-eyebrow">{compose.loadingEyebrow}</p>
              <h3>{compose.loadingTitle}</h3>
              <ol className="loading-steps">
                {compose.loadingSteps.map((step, index) => (
                  <li key={step} className={index === 0 ? "done" : index === 1 ? "active" : ""}>{step}</li>
                ))}
              </ol>
            </div>
          )
          : (
            <div className="result-empty">
              <p className="panel-eyebrow">{compose.previewEyebrow}</p>
              <h3>{compose.previewTitle}</h3>
              <p className="result-empty-lede">{compose.previewLede}</p>
              <ol className="preview-list">
                {compose.previewItems.map((item, index) => (
                  <li key={item.title}>
                    <b>{index + 1}</b>
                    <div><strong>{item.title}</strong><span>{item.detail}</span></div>
                  </li>
                ))}
              </ol>
              <p className="preview-foot">{compose.previewFoot}</p>
            </div>
          )}
      </div>
    </div>
  );
}
