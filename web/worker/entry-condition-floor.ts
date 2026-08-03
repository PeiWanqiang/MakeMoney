/**
 * A structural floor on `ready` strategies.
 *
 * A model that loses the user's intent still returns a well-formed contract —
 * it just returns one that opens on every bar. Schema validation cannot tell
 * that apart from a strategy the user actually described, and the backtest will
 * happily produce an equity curve for it, so the shape is caught here.
 *
 * Kept free of imports so it stays directly testable.
 */

/**
 * A canonical condition touches the market only through an indicator call or a
 * `market.*` field. Everything else the notation allows — `position.*`,
 * `account.*`, `state.*`, literals — describes the account, not the chart.
 *
 * Written as "is there a call or a market field" rather than a list of known
 * indicator names, so a newly added indicator counts without touching this.
 */
export function referencesMarket(condition: string): boolean {
  return /\w\s*\(/.test(condition) || /\bmarket\./.test(condition);
}

/**
 * An `open` rule whose conditions never look at the market opens on every bar.
 * That is a legitimate strategy (buy and hold) but almost never what someone
 * meant, so it becomes a question rather than a rejection: buy-and-hold users
 * confirm, everyone else is spared a strategy they never described.
 */
export function enforceEntryConditionFloor(artifact: Record<string, unknown>, language: "zh-CN" | "en"): void {
  if (artifact.status !== "ready") return;
  const contract = artifact.contract as { rules?: unknown } | null;
  const rules = Array.isArray(contract?.rules) ? contract.rules : [];
  const unconditionalOpen = rules.some((rule) => {
    const value = rule as { when?: unknown; decision?: { type?: unknown } };
    if (value.decision?.type !== "open") return false;
    const when = Array.isArray(value.when) ? value.when.filter((item): item is string => typeof item === "string") : [];
    return !when.some(referencesMarket);
  });
  if (!unconditionalOpen) return;

  artifact.status = "needs_clarification";
  artifact.contract = null;
  artifact.source = "";
  artifact.clarificationQuestions = [
    language === "zh-CN"
      ? "这个策略没有基于行情的入场条件，只要空仓就会开仓。如果你想要的是持续持仓，请回答“是”；否则请补充入场需要满足的行情条件（例如指标、价格或突破条件）。"
      : "This strategy has no market-based entry condition, so it opens a position whenever it is flat. Answer \"yes\" if you want a continuous position; otherwise describe the market condition that should trigger entry (an indicator, price level, or breakout).",
  ];
}
