"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getMessages, type Messages } from "./i18n";
import { localePath, LOCALE_TAG, type Locale } from "./i18n/locales";
import type { StrategyListItem } from "./strategy-store";

interface Props {
  locale: Locale;
  strategies: StrategyListItem[];
}

function percent(value: number | null): string {
  return value === null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

/** Maps stored state to the single progress word the customer sees. */
function progressKey(item: StrategyListItem): keyof Messages["strategies"]["progress"] {
  if (item.status === "needs_clarification") return "needsClarification";
  if (item.status === "unsupported") return "unsupported";
  if (item.optimized) return "optimized";
  if (item.lastBacktestAt) return "backtested";
  if (item.confirmedAt) return "confirmed";
  return "draft";
}

export default function StrategyList({ locale, strategies }: Props) {
  const copy = getMessages(locale).strategies;
  const router = useRouter();
  const [items, setItems] = useState(strategies);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(LOCALE_TAG[locale], { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));

  async function rename(id: string) {
    const title = draftTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    const response = await fetch(`/api/strategy/${id}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }).catch(() => null);
    if (response?.ok) setItems((current) => current.map((item) => item.id === id ? { ...item, title } : item));
    setRenaming(null);
    setBusy(false);
  }

  async function remove(id: string) {
    if (busy || !window.confirm(copy.removeConfirm)) return;
    setBusy(true);
    const response = await fetch(`/api/strategy/${id}/delete`, { method: "POST" }).catch(() => null);
    if (response?.ok) {
      setItems((current) => current.filter((item) => item.id !== id));
      router.refresh();
    }
    setBusy(false);
  }

  if (items.length === 0) {
    return (
      <div className="panel strategies-empty">
        <h3>{copy.emptyTitle}</h3>
        <p>{copy.emptyDetail}</p>
        <Link className="primary-action" href={localePath(locale, "/new")}><span>{copy.emptyCta}</span><b>→</b></Link>
      </div>
    );
  }

  return (
    <div className="strategy-list">
      {items.map((item) => {
        const key = progressKey(item);
        return (
          <article className={`strategy-card ${key}`} key={item.id}>
            <div className="strategy-card-main">
              {renaming === item.id
                ? (
                  <div className="rename-row">
                    <input
                      value={draftTitle}
                      autoFocus
                      placeholder={copy.renamePlaceholder}
                      onChange={(event) => setDraftTitle(event.target.value.slice(0, 120))}
                      onKeyDown={(event) => { if (event.key === "Enter") void rename(item.id); }}
                      aria-label={copy.renameTitle}
                    />
                    <button onClick={() => void rename(item.id)} disabled={busy}>{copy.renameSave}</button>
                    <button className="ghost" onClick={() => setRenaming(null)}>{copy.renameCancel}</button>
                  </div>
                )
                : <h3><Link href={localePath(locale, `/s/${item.id}`)}>{item.title || copy.untitled}</Link></h3>}
              <p className="strategy-meta">
                {item.asset} · {item.market}{item.timeframe ? ` · ${item.timeframe}` : ""}
              </p>
            </div>

            <div className="strategy-card-progress">
              <span className={`progress-badge ${key}`}>{copy.progress[key]}</span>
              <small>{formatDate(item.createdAt)}</small>
            </div>

            <div className="strategy-card-result">
              {item.lastBacktestAt
                ? copy.resultSummary(percent(item.netReturn), percent(item.maximumDrawdown), item.tradeCount ?? 0)
                : <span className="muted">{copy.noBacktest}</span>}
            </div>

            <div className="strategy-card-actions">
              <Link className="ghost-button" href={localePath(locale, `/s/${item.id}`)}>{copy.resume}</Link>
              <button onClick={() => { setRenaming(item.id); setDraftTitle(item.title ?? ""); }}>{copy.rename}</button>
              <button className="danger" onClick={() => void remove(item.id)}>{copy.remove}</button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
