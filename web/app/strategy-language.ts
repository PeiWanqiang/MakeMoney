/**
 * Plain-language renderer for the machine strategy contract.
 *
 * It translates the canonical condition grammar the backtest interpreter executes
 * (`position.side`, `crossAbove/crossBelow`, relational comparisons over indicator
 * calls) into sentences a trader can read. It is a general renderer over the
 * documented grammar: unknown expressions fall back to the original text instead of
 * being guessed at, so the customer never sees an invented meaning.
 *
 * Every sentence is produced by a locale-owned builder in `i18n/*`, never by
 * concatenating fragments here — Chinese and English order periods, fields and
 * indicator names differently, and a shared template would silently produce
 * broken grammar in one of them.
 */

import type { Messages } from "./i18n";

export interface ContractDecision {
  type?: string;
  side?: string | null;
  sizeKind?: string | null;
  sizeValue?: number | null;
  /** A constant, or an expression in the same grammar the conditions use. */
  stopLossPercent?: number | string | null;
  takeProfitRiskReward?: number | string | null;
  /** Share of the position a close takes off, or null/absent for all of it. */
  closeFraction?: number | null;
}

export interface ContractRule {
  when?: string[];
  decision?: ContractDecision | Record<string, unknown>;
}

export interface PlainRule {
  index: number;
  kind: "entry" | "exit" | "other";
  badge: string;
  action: string;
  state: string | null;
  signals: string[];
  risk: string[];
  raw: string[];
}

export function timeframeLabel(messages: Messages, timeframe?: string | null): string {
  if (!timeframe) return messages.contract.timeframeFallback;
  return messages.contract.timeframeSuffix(messages.contract.timeframes[timeframe] ?? timeframe);
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const percent = value * 100;
  return `${Number.isInteger(percent) ? percent : Number(percent.toPrecision(4))}%`;
}

function lagSuffix(messages: Messages, lag: string | number | undefined): string {
  const value = Number(lag ?? 0);
  return Number.isFinite(value) && value > 0 ? messages.contract.lag(value) : "";
}

/** Replaces every recognised indicator or market reference with a localised term, keeping arithmetic intact. */
export function humanizeExpression(messages: Messages, expression: string): string {
  const { contract } = messages;
  let text = expression.trim();
  text = text.replace(/timeframe\("(1m|15m|1h|4h)"\)\./g, (_match, timeframe: string) =>
    contract.higherTimeframe(contract.timeframes[timeframe] ?? timeframe),
  );
  text = text.replace(
    /bollingerBands\("(\w+)",\s*(\d+),\s*([\d.]+),\s*(\d+)\)\.(upper|middle|lower)/g,
    (_match, _field: string, period: string, multiplier: string, lag: string, band: string) =>
      contract.bollinger(contract.bollingerBands[band] ?? band, period, multiplier, lagSuffix(messages, lag)),
  );
  text = text.replace(
    /macd\("(\w+)",\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)\.(macd|signal|histogram)/g,
    (_match, _field: string, fast: string, slow: string, signal: string, lag: string, part: string) =>
      contract.macd(contract.macdParts[part] ?? part, fast, slow, signal, lagSuffix(messages, lag)),
  );
  text = text.replace(/(sma|ema|rsi|highest|lowest)\("(\w+)",\s*(\d+),\s*(\d+)\)/g, (_match, name: string, field: string, period: string, lag: string) => {
    const fieldName = contract.fields[field] ?? field;
    const suffix = lagSuffix(messages, lag);
    if (name === "sma") return contract.sma(period, fieldName, suffix);
    if (name === "ema") return contract.ema(period, fieldName, suffix);
    if (name === "rsi") return contract.rsi(period, suffix);
    if (name === "highest") return contract.highest(period, fieldName, suffix);
    return contract.lowest(period, fieldName, suffix);
  });
  text = text.replace(/percentChange\("(\w+)",\s*(\d+)(?:,\s*(\d+))?\)/g, (_match, field: string, period: string, lag: string) =>
    contract.percentChange(period, contract.fields[field] ?? field, lagSuffix(messages, lag)),
  );
  text = text.replace(/atr\(\s*(\d+),\s*(\d+)\)/g, (_match, period: string, lag: string) => contract.atr(period, lagSuffix(messages, lag)));
  text = text.replace(/market\.(open|high|low|close|volume)/g, (_match, field: string) => contract.fields[field] ?? field);
  text = text.replace(/\s*\*\s*/g, " × ");
  return text.replace(/\s+/g, " ").trim();
}

function splitArguments(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const character of value) {
    if (character === '"') quoted = !quoted;
    if (!quoted) {
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (character === "," && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += character;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim());
}

function findComparison(value: string): { left: string; operator: string; right: string } | null {
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '"') quoted = !quoted;
    if (quoted) continue;
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth !== 0) continue;
    const pair = value.slice(index, index + 2);
    if (pair === ">=" || pair === "<=" || pair === "==") {
      return { left: value.slice(0, index), operator: pair, right: value.slice(index + 2) };
    }
    if (character === ">" || character === "<") {
      return { left: value.slice(0, index), operator: character, right: value.slice(index + 1) };
    }
  }
  return null;
}

/** Turns one contract condition into a readable sentence, or returns the original text when the grammar is unknown. */
export function describeCondition(messages: Messages, raw: string): string {
  const compact = raw.replace(/\s+/g, "");
  const position = /^position\.side==("|')(flat|long|short)\1$/.exec(compact);
  if (position) return messages.contract.positions[position[2]!] ?? compact;

  const cross = /^(crossAbove|crossBelow)\((.*)\)$/.exec(compact);
  if (cross) {
    const args = splitArguments(cross[2]!);
    if (args.length === 4) {
      const verb = cross[1] === "crossAbove" ? messages.contract.crossAbove : messages.contract.crossBelow;
      return `${humanizeExpression(messages, args[0]!)} ${verb} ${humanizeExpression(messages, args[2]!)}`;
    }
  }

  const comparison = findComparison(compact);
  if (comparison && comparison.left.trim() && comparison.right.trim()) {
    const operator = messages.contract.comparisons[comparison.operator] ?? comparison.operator;
    return `${humanizeExpression(messages, comparison.left)} ${operator} ${humanizeExpression(messages, comparison.right)}`;
  }
  return humanizeExpression(messages, raw);
}

/** The share a partial close takes off, or null when it closes everything. */
function partialShare(decision: ContractDecision): number | null {
  const value = decision.closeFraction;
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1 ? value : null;
}

function describeAction(messages: Messages, decision: ContractDecision): string {
  if (decision.type === "close") {
    const share = partialShare(decision);
    return share === null ? messages.contract.actionClose : messages.contract.actionClosePartial(formatPercent(share));
  }
  if (decision.type === "open") {
    if (decision.side === "long") return messages.contract.actionOpenLong;
    if (decision.side === "short") return messages.contract.actionOpenShort;
    return messages.contract.actionOpen;
  }
  return decision.type ? String(decision.type) : messages.contract.actionOther;
}

function describeRisk(messages: Messages, decision: ContractDecision): string[] {
  const items: string[] = [];
  const size = decision.sizeValue;
  if (typeof size === "number" && Number.isFinite(size)) {
    if (decision.sizeKind === "riskPercent") items.push(messages.contract.riskRiskPercent(formatPercent(size)));
    else if (decision.sizeKind === "equityPercent") items.push(messages.contract.riskEquityPercent(formatPercent(size)));
    else if (decision.sizeKind === "fixedNotional") items.push(messages.contract.riskFixedNotional(formatNumber(size)));
    else items.push(messages.contract.riskSize(formatNumber(size)));
  }
  // A stop or target may be sized from market data rather than fixed, so the
  // expression is read back the same way a condition is. Disclosing "止损 2×ATR"
  // is the whole point of quantifying it: the customer confirms the calculation,
  // not just whatever number it happened to produce.
  if (typeof decision.stopLossPercent === "number" && Number.isFinite(decision.stopLossPercent)) {
    items.push(messages.contract.riskStopLoss(formatPercent(decision.stopLossPercent)));
  } else if (typeof decision.stopLossPercent === "string" && decision.stopLossPercent.trim()) {
    items.push(messages.contract.riskStopLoss(humanizeExpression(messages, decision.stopLossPercent)));
  }
  if (typeof decision.takeProfitRiskReward === "number" && Number.isFinite(decision.takeProfitRiskReward)) {
    items.push(messages.contract.riskTakeProfit(formatNumber(decision.takeProfitRiskReward)));
  } else if (typeof decision.takeProfitRiskReward === "string" && decision.takeProfitRiskReward.trim()) {
    items.push(messages.contract.riskTakeProfit(humanizeExpression(messages, decision.takeProfitRiskReward)));
  }
  return items;
}

/** Renders the machine decision of one rule as a short label for the expert view. */
export function describeDecision(messages: Messages, decision: Record<string, unknown> | undefined): string {
  if (!decision) return messages.contract.decisionUnknown;
  const share = partialShare(decision as ContractDecision);
  const type = decision.type === "open"
    ? messages.contract.decisionOpen
    : decision.type === "close"
      ? share === null ? messages.contract.decisionClose : messages.contract.decisionClosePartial(formatPercent(share))
      : String(decision.type ?? messages.contract.actionOther);
  const side = decision.side === "long"
    ? messages.contract.sideLong
    : decision.side === "short"
      ? messages.contract.sideShort
      : "";
  return [type, side].filter(Boolean).join(" · ");
}

/** Projects contract rules into the cards shown on the confirmation step. */
export function describeRules(messages: Messages, rules: ContractRule[] | undefined | null): PlainRule[] {
  if (!Array.isArray(rules)) return [];
  return rules.map((rule, index) => {
    const decision = (rule.decision ?? {}) as ContractDecision;
    const conditions = Array.isArray(rule.when) ? rule.when : [];
    const stateConditions: string[] = [];
    const signals: string[] = [];
    for (const condition of conditions) {
      const compact = condition.replace(/\s+/g, "");
      if (/^position\.side==("|')(flat|long|short)\1$/.test(compact)) stateConditions.push(describeCondition(messages, condition));
      else signals.push(describeCondition(messages, condition));
    }
    const kind = decision.type === "open" ? "entry" : decision.type === "close" ? "exit" : "other";
    return {
      index,
      kind,
      badge: kind === "entry" ? messages.contract.badgeEntry : kind === "exit" ? messages.contract.badgeExit : messages.contract.badgeOther,
      action: describeAction(messages, decision),
      state: stateConditions.length > 0 ? stateConditions.join(messages.contract.stateJoin) : null,
      signals,
      risk: describeRisk(messages, decision),
      raw: conditions,
    };
  });
}
