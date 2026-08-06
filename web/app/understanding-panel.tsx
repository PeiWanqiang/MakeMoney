"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { describeApiFailure, type ApiErrorPayload } from "./api-error";
import { getMessages } from "./i18n";
import { localePath, type Locale } from "./i18n/locales";
import { describeDecision, describeRules, timeframeLabel } from "./strategy-language";

export type ResultStatus = "ready" | "needs_clarification" | "unsupported";

export interface StrategyArtifact {
  id: string;
  status: ResultStatus;
  strategyName?: string;
  summary?: string;
  clarificationQuestions: string[];
  unsupportedCapabilities: string[];
  assumptions: string[];
  warnings: string[];
  contract: { timeframe?: string; rules?: Array<{ when?: string[]; decision?: Record<string, unknown> }> } | null;
  source?: string;
  checks: Array<{ id: string; label: string; status: "passed" | "failed" | "not_applicable"; detail: string }>;
  generation: { model: string; latencyMs: number };
}

interface Props {
  locale: Locale;
  strategyId: string;
  intent: string;
  asset: string;
  market: string;
  artifact: StrategyArtifact;
  confirmed: boolean;
  signedIn: boolean;
}

function usesChinese(value: string): boolean {
  return (value.match(/[㐀-鿿]/g)?.length ?? 0) >= 2;
}

/** Rebuilds the intent from the original text plus this round's answers. */
function mergeClarificationContext(intent: string, questions: string[], answers: string[]): string {
  const chinese = usesChinese(intent);
  const sections = questions.map((question, index) =>
    `${index + 1}. ${question}\n${chinese ? "回答" : "Answer"}: ${answers[index]?.trim() ?? ""}`,
  );
  return [
    chinese ? "原始策略：" : "Original strategy:",
    intent.trim(),
    "",
    chinese ? "补充回答：" : "Clarification answers:",
    ...sections,
  ].join("\n").slice(0, 5000);
}

/**
 * Step 2. The customer reads the machine reading of their own words and makes one
 * decision about it. Confirming writes `confirmed_at` server-side, which is what
 * lets step 3 be its own route instead of a scroll position.
 */
export default function UnderstandingPanel({
  locale, strategyId, intent, asset, market, artifact, confirmed, signedIn,
}: Props) {
  const messages = getMessages(locale);
  const { confirm: copy, errors } = messages;
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"contract" | "code">("contract");
  const [feedback, setFeedback] = useState<"correct" | "incorrect" | null>(null);
  const [feedbackNote, setFeedbackNote] = useState("");
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [answers, setAnswers] = useState<string[]>(() => artifact.clarificationQuestions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Rendering a handful of contract rules is cheap; the React Compiler handles
  // the memoization, and a manual useMemo here only blocks it.
  const rules = artifact.contract?.rules ?? [];
  const plainRules = describeRules(messages, rules);
  const answeredCount = answers.filter((answer) => answer.trim()).length;
  const backtestHref = localePath(locale, `/s/${strategyId}/backtest`);

  async function sendFeedback(verdict: "correct" | "incorrect", note: string) {
    if (feedbackSent) return;
    const response = await fetch("/api/strategy/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: strategyId, feedback: verdict, note }),
    });
    if (response.ok) setFeedbackSent(true);
  }

  async function acceptUnderstanding() {
    if (artifact.status !== "ready" || busy) return;
    setBusy(true);
    setError("");
    try {
      void sendFeedback("correct", feedbackNote);
      const response = await fetch(`/api/strategy/${strategyId}/confirm`, { method: "POST" });
      if (!response.ok) {
        throw new Error(describeApiFailure(messages, await response.json() as ApiErrorPayload, errors.INTERNAL_ERROR));
      }
      router.push(backtestHref);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : errors.INTERNAL_ERROR);
      setBusy(false);
    }
  }

  async function submitClarifications() {
    if (artifact.status !== "needs_clarification" || busy) return;
    if (answers.some((answer) => !answer.trim())) return;
    setBusy(true);
    setError("");
    try {
      const merged = mergeClarificationContext(intent, artifact.clarificationQuestions, answers);
      const response = await fetch("/api/strategy/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: merged, asset, market, locale }),
      });
      const payload = await response.json() as ApiErrorPayload & { id?: string };
      if (!response.ok || !payload.id) throw new Error(describeApiFailure(messages, payload, errors.ANALYZE_FAILED));
      router.push(localePath(locale, `/s/${payload.id}/confirm`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : errors.ANALYZE_FAILED);
      setBusy(false);
    }
  }

  async function submitCorrection() {
    await sendFeedback("incorrect", feedbackNote);
    router.push(localePath(locale, "/new"));
  }

  return (
    <div className={`panel result-panel has-result status-${artifact.status}`}>
      <div className="result-content">
        <div className="result-head">
          <span className="result-seal">{copy.seal[artifact.status]}</span>
          <p>{copy.detail[artifact.status]}</p>
        </div>

        {artifact.summary && (
          <div className="summary-card">
            <span>{copy.summaryLabel}</span>
            <p>{artifact.summary}</p>
          </div>
        )}

        {plainRules.length > 0 && (
          <div className="plain-rules">
            <div className="plain-rules-head">
              <strong>{copy.rulesTitle}</strong>
              <small>{copy.rulesSubtitle(timeframeLabel(messages, artifact.contract?.timeframe))}</small>
            </div>
            {plainRules.map((rule) => (
              <article className={`plain-rule ${rule.kind}`} key={rule.index}>
                <header><b>{rule.badge}</b><strong>{rule.action}</strong></header>
                <dl>
                  <div>
                    <dt>{copy.ruleWhen}</dt>
                    <dd>{[rule.state, ...rule.signals].filter(Boolean).join(messages.contract.conditionJoin) || copy.ruleAnytime}</dd>
                  </div>
                  {rule.risk.length > 0 && (
                    <div>
                      <dt>{copy.ruleRisk}</dt>
                      <dd>{rule.risk.join(" · ")}</dd>
                    </div>
                  )}
                </dl>
              </article>
            ))}
          </div>
        )}

        {artifact.clarificationQuestions.length > 0 && (
          <div className="question-list">
            <div className="question-list-head">
              <strong>{copy.questionsTitle}</strong>
              <span>{copy.questionsProgress(answeredCount, artifact.clarificationQuestions.length)}</span>
            </div>
            {artifact.clarificationQuestions.map((question, index) => (
              <div className={`question-card ${answers[index]?.trim() ? "answered" : ""}`} key={`${index}-${question}`}>
                <b>{index + 1}</b>
                <label>
                  <span>{question}</span>
                  <textarea
                    value={answers[index] ?? ""}
                    onChange={(event) => setAnswers((current) =>
                      current.map((answer, position) => position === index ? event.target.value.slice(0, 1000) : answer))}
                    aria-label={copy.questionAria(index + 1, question)}
                    placeholder={copy.questionPlaceholder}
                  />
                </label>
              </div>
            ))}
            <button
              className="primary-action"
              onClick={() => void submitClarifications()}
              disabled={busy || answers.some((answer) => !answer.trim())}
            >
              <span>{copy.mergeAnswers}</span><b>{busy ? <i className="spinner" /> : "→"}</b>
            </button>
            <p className="side-note">{copy.mergeNote}</p>
          </div>
        )}

        {artifact.unsupportedCapabilities.length > 0 && (
          <div className="boundary-list">
            <span>{copy.boundaryTitle}</span>
            {artifact.unsupportedCapabilities.map((capability) => <p key={capability}>{capability}</p>)}
          </div>
        )}

        {error && <div className="alert error" role="alert"><span>{error}</span></div>}

        {artifact.status === "ready" && (
          <div className={`decision-bar ${confirmed ? "confirmed" : ""}`}>
            <div>
              <strong>{confirmed ? copy.decisionConfirmed : copy.decisionQuestion}</strong>
              <span>{confirmed ? copy.decisionConfirmedDetail : copy.decisionDetail}</span>
            </div>
            {confirmed
              ? <a className="decision-jump" href={backtestHref}>{copy.jumpToBacktest} →</a>
              : signedIn
                ? (
                  <div className="decision-actions">
                    <button className="agree" onClick={() => void acceptUnderstanding()} disabled={busy}>{copy.accept} →</button>
                    <button className="disagree" onClick={() => setFeedback("incorrect")}>{copy.reject}</button>
                  </div>
                )
                : (
                  <div className="decision-actions">
                    <a className="agree" href={`/api/auth/google/start?return_to=${encodeURIComponent(localePath(locale, `/s/${strategyId}/confirm`))}`}>
                      {copy.signInToContinue} →
                    </a>
                    <button className="disagree" onClick={() => setFeedback("incorrect")}>{copy.reject}</button>
                  </div>
                )}
          </div>
        )}

        {artifact.status === "ready" && !signedIn && <p className="side-note">{copy.signInReason}</p>}

        {artifact.status === "unsupported" && (
          <div className="decision-bar boundary">
            <div>
              <strong>{copy.unsupportedTitle}</strong>
              <span>{copy.unsupportedDetail}</span>
            </div>
            <div className="decision-actions">
              <a className="agree" href={localePath(locale, "/new")}>{copy.unsupportedRestart}</a>
              <button className="disagree" onClick={() => setFeedback("incorrect")}>{copy.unsupportedDispute}</button>
            </div>
          </div>
        )}

        {feedback === "incorrect" && !feedbackSent && (
          <div className="correction-box">
            <label>
              {copy.correctionLabel}
              <textarea value={feedbackNote} onChange={(event) => setFeedbackNote(event.target.value)} placeholder={copy.correctionPlaceholder} />
            </label>
            <div className="correction-actions">
              <button onClick={() => void submitCorrection()}>{copy.correctionSubmit}</button>
              <button className="ghost" onClick={() => setFeedback(null)}>{copy.correctionCancel}</button>
            </div>
          </div>
        )}
        {feedbackSent && feedback === "incorrect" && <p className="thanks">{copy.correctionThanks}</p>}

        <details className="expert-view">
          <summary>{copy.expertSummary}</summary>
          <div className="expert-body">
            <div className="expert-tabs" role="tablist">
              <button className={activeTab === "contract" ? "active" : ""} onClick={() => setActiveTab("contract")} disabled={!artifact.contract}>{copy.tabContract}</button>
              <button className={activeTab === "code" ? "active" : ""} onClick={() => setActiveTab("code")} disabled={!artifact.source}>{copy.tabCode}</button>
            </div>

            {activeTab === "contract" && artifact.contract && (
              <div className="contract-view">
                <div className="contract-meta">
                  <span>SCHEMA 1.0</span>
                  <strong>{artifact.contract.timeframe}</strong>
                  <span>{copy.contractRuleCount(rules.length)}</span>
                </div>
                {rules.map((rule, index) => (
                  <div className="rule-card" key={index}>
                    <b>RULE {String(index + 1).padStart(2, "0")}</b>
                    <div>{rule.when?.map((condition) => <code key={condition}>{condition}</code>)}</div>
                    <span>{describeDecision(messages, rule.decision)}</span>
                  </div>
                ))}
              </div>
            )}

            {activeTab === "code" && artifact.source && (
              <div className="code-view">
                <div className="code-top"><span>{copy.codeFilename}</span><span>{copy.codeNote}</span></div>
                <pre><code>{artifact.source}</code></pre>
              </div>
            )}

            <div className="check-grid">
              {artifact.checks.map((check) => (
                <div className={`check ${check.status}`} key={check.id}>
                  <i>{check.status === "passed" ? "✓" : check.status === "failed" ? "!" : "—"}</i>
                  <span><strong>{check.label}</strong><small>{check.detail}</small></span>
                </div>
              ))}
            </div>

            {(artifact.assumptions.length > 0 || artifact.warnings.length > 0) && (
              <div className="assumption-list">
                <strong>{copy.assumptionsTitle}</strong>
                {[...artifact.assumptions, ...artifact.warnings].map((item) => <p key={item}>— {item}</p>)}
              </div>
            )}

            <p className="side-note">{copy.generationNote(artifact.generation.model, (artifact.generation.latencyMs / 1000).toFixed(1))}</p>
          </div>
        </details>

        <div className="result-foot">
          <a href={localePath(locale, "/new")}>← {copy.restart}</a>
        </div>
      </div>
    </div>
  );
}
