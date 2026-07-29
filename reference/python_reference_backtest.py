#!/usr/bin/env python3
"""Independent stdlib-only reference backtester for cross-validation.

This intentionally does not import or execute the TypeScript engine. It consumes a
versioned JSON fixture and implements the agreed bar semantics a second time.
"""

import json
import math
import sys
from typing import Any, Dict, List, Optional


REFERENCE_ENGINE_VERSION = "python-reference-0.1.0"


class EmaSeries:
    def __init__(self, period: int) -> None:
        self.period = period
        self.alpha = 2.0 / (period + 1.0)
        self.values: List[Optional[float]] = []

    def append(self, closes: List[float]) -> None:
        index = len(closes) - 1
        if index + 1 < self.period:
            self.values.append(None)
        elif index + 1 == self.period:
            self.values.append(sum(closes[: self.period]) / self.period)
        else:
            previous = self.values[index - 1]
            self.values.append(
                None if previous is None else self.alpha * closes[index] + (1.0 - self.alpha) * previous
            )

    def value(self, offset: int = 0) -> Optional[float]:
        index = len(self.values) - 1 - offset
        return self.values[index] if index >= 0 else None


def crossed_above(
    current_a: Optional[float],
    previous_a: Optional[float],
    current_b: Optional[float],
    previous_b: Optional[float],
) -> bool:
    values = [current_a, previous_a, current_b, previous_b]
    return all(value is not None and math.isfinite(value) for value in values) and previous_a <= previous_b and current_a > current_b  # type: ignore[operator]


def crossed_below(
    current_a: Optional[float],
    previous_a: Optional[float],
    current_b: Optional[float],
    previous_b: Optional[float],
) -> bool:
    values = [current_a, previous_a, current_b, previous_b]
    return all(value is not None and math.isfinite(value) for value in values) and previous_a >= previous_b and current_a < current_b  # type: ignore[operator]


def with_slippage(price: float, side: str, bps: float) -> float:
    rate = bps / 10_000.0
    return price * (1.0 + rate) if side == "buy" else price * (1.0 - rate)


def strategy_decision(
    strategy: Dict[str, Any],
    position: Optional[Dict[str, Any]],
    bar: Dict[str, Any],
    fast: EmaSeries,
    slow: EmaSeries,
) -> Dict[str, Any]:
    fast_now = fast.value()
    fast_previous = fast.value(1)
    slow_now = slow.value()
    slow_previous = slow.value(1)
    side = "flat" if position is None else position["side"]
    cross_up = crossed_above(fast_now, fast_previous, slow_now, slow_previous)
    cross_down = crossed_below(fast_now, fast_previous, slow_now, slow_previous)

    if strategy["kind"] == "ema-trend":
        if side == "flat" and cross_up:
            return {
                "type": "open",
                "side": "long",
                "riskPercent": strategy["riskPercent"],
                "stopLossPercent": strategy["stopLossPercent"],
                "takeProfitRiskReward": None,
                "reason": "20-period EMA crossed above 50-period EMA",
            }
        if side == "long" and cross_down:
            return {"type": "close", "reason": "20-period EMA crossed below 50-period EMA"}
    elif strategy["kind"] == "ema-negative-funding":
        if side == "flat" and float(bar.get("fundingRate", 0.0)) < 0.0 and cross_up:
            return {
                "type": "open",
                "side": "long",
                "riskPercent": strategy["riskPercent"],
                "stopLossPercent": strategy["stopLossPercent"],
                "takeProfitRiskReward": strategy["takeProfitRiskReward"],
                "reason": "fast EMA crossed above slow EMA while funding was negative",
            }
        if side == "long" and cross_down:
            return {"type": "close", "reason": "fast EMA crossed below slow EMA"}
    else:
        raise ValueError("Unsupported reference strategy: " + str(strategy["kind"]))
    return {"type": "hold"}


def run(fixture: Dict[str, Any]) -> Dict[str, Any]:
    if fixture.get("schemaVersion") != "1.0":
        raise ValueError("Unsupported fixture schema")
    bars = fixture["bars"]
    config = fixture["config"]
    strategy = fixture["strategy"]
    if len(bars) < 2:
        raise ValueError("At least two bars are required")

    cash = float(config["initialCapital"])
    position: Optional[Dict[str, Any]] = None
    pending: Optional[Dict[str, Any]] = None
    trades: List[Dict[str, Any]] = []
    equity_curve: List[Dict[str, Any]] = []
    closes: List[float] = []
    fast = EmaSeries(int(strategy["fastPeriod"]))
    slow = EmaSeries(int(strategy["slowPeriod"]))

    def close_position(bar: Dict[str, Any], raw_price: float, reason: str) -> None:
        nonlocal cash, position
        if position is None:
            return
        closing_side = "sell" if position["side"] == "long" else "buy"
        exit_price = with_slippage(raw_price, closing_side, float(config["slippageBps"]))
        exit_slippage = abs(exit_price - raw_price) * position["quantity"]
        direction = 1.0 if position["side"] == "long" else -1.0
        gross_pnl = direction * (exit_price - position["entryPrice"]) * position["quantity"]
        exit_fee = exit_price * position["quantity"] * float(config["takerFeeRate"])
        cash += gross_pnl - exit_fee
        fees = position["entryFee"] + exit_fee
        trades.append(
            {
                "side": position["side"],
                "entryTimestamp": position["entryTimestamp"],
                "exitTimestamp": bar["timestamp"],
                "entryPrice": position["entryPrice"],
                "exitPrice": exit_price,
                "quantity": position["quantity"],
                "grossPnl": gross_pnl,
                "fundingPnl": position["fundingPnl"],
                "fees": fees,
                "slippageCost": position["entrySlippageCost"] + exit_slippage,
                "netPnl": gross_pnl + position["fundingPnl"] - fees,
                "exitReason": reason,
            }
        )
        position = None

    for bar in bars:
        if pending is not None and pending["type"] == "open" and position is None:
            fill_side = "buy" if pending["side"] == "long" else "sell"
            entry_price = with_slippage(float(bar["open"]), fill_side, float(config["slippageBps"]))
            risk_capital = cash * float(pending["riskPercent"])
            requested_notional = risk_capital / float(pending["stopLossPercent"])
            max_notional = max(0.0, cash * float(config["maxLeverage"]))
            quantity = min(requested_notional, max_notional) / entry_price
            entry_fee = entry_price * quantity * float(config["takerFeeRate"])
            cash -= entry_fee
            direction = 1.0 if pending["side"] == "long" else -1.0
            stop_distance = entry_price * float(pending["stopLossPercent"])
            risk_reward = pending.get("takeProfitRiskReward")
            position = {
                "side": pending["side"],
                "quantity": quantity,
                "entryPrice": entry_price,
                "entryTimestamp": bar["timestamp"],
                "entryFee": entry_fee,
                "entrySlippageCost": abs(entry_price - float(bar["open"])) * quantity,
                "fundingPnl": 0.0,
                "stopPrice": entry_price - direction * stop_distance,
                "takeProfitPrice": None if risk_reward is None else entry_price + direction * stop_distance * float(risk_reward),
            }
        elif pending is not None and pending["type"] == "close" and position is not None:
            close_position(bar, float(bar["open"]), pending.get("reason", "strategy"))
        pending = None

        if position is not None:
            mark_price = float(bar.get("markPrice", bar["close"]))
            notional = position["quantity"] * mark_price
            direction = 1.0 if position["side"] == "long" else -1.0
            funding_pnl = -direction * notional * float(bar.get("fundingRate", 0.0))
            cash += funding_pnl
            position["fundingPnl"] += funding_pnl
            stop_hit = float(bar["low"]) <= position["stopPrice"] if position["side"] == "long" else float(bar["high"]) >= position["stopPrice"]
            take_price = position["takeProfitPrice"]
            take_hit = take_price is not None and (float(bar["high"]) >= take_price if position["side"] == "long" else float(bar["low"]) <= take_price)
            if stop_hit:
                close_position(bar, position["stopPrice"], "stopLoss")
            elif take_hit and position is not None:
                close_position(bar, position["takeProfitPrice"], "takeProfit")

        mark_price = float(bar.get("markPrice", bar["close"]))
        unrealized = 0.0
        if position is not None:
            direction = 1.0 if position["side"] == "long" else -1.0
            unrealized = direction * (mark_price - position["entryPrice"]) * position["quantity"]
        equity_curve.append({"timestamp": bar["timestamp"], "equity": cash + unrealized})

        closes.append(float(bar["close"]))
        fast.append(closes)
        slow.append(closes)
        pending = strategy_decision(strategy, position, bar, fast, slow)

    if position is not None:
        close_position(bars[-1], float(bars[-1]["close"]), "endOfData")
        equity_curve[-1]["equity"] = cash

    initial_capital = float(config["initialCapital"])
    return {
        "referenceEngineVersion": REFERENCE_ENGINE_VERSION,
        "initialCapital": initial_capital,
        "finalEquity": cash,
        "returnPercent": cash / initial_capital - 1.0,
        "trades": trades,
        "equityCurve": equity_curve,
    }


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python_reference_backtest.py INPUT.json OUTPUT.json")
    with open(sys.argv[1], "r", encoding="utf-8") as source:
        fixture = json.load(source)
    result = run(fixture)
    with open(sys.argv[2], "w", encoding="utf-8") as destination:
        json.dump(result, destination, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        destination.write("\n")


if __name__ == "__main__":
    main()
