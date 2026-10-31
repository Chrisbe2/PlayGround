from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .models import Candle


@dataclass(frozen=True)
class ReviewResult:
    outcome: str
    r_multiple: float
    mfe_r: float
    mae_r: float
    candles_seen: int
    last_close: float | None


def evaluate_entry(
    entry: dict, candles: Sequence[Candle], horizon_minutes: int = 240
) -> ReviewResult:
    """Replay one journaled signal against later candles.

    Ties inside a single candle are resolved conservatively: the stop is
    assumed to have been hit before a target. Reference entries are candle
    closes, not real fills, and fees/slippage are excluded.
    """
    side = str(entry.get("side", "")).lower()
    entry_price = float(entry["entry"])
    stop = float(entry["stop"])
    take_profit_1 = float(entry["take_profit_1"])
    take_profit_2 = float(entry["take_profit_2"])
    candle_time = int(entry["candle_time"])
    risk = abs(entry_price - stop)
    if side not in {"long", "short"} or risk <= 0:
        raise ValueError("entry has an invalid side or zero risk distance")

    end_time = candle_time + horizon_minutes * 60_000
    relevant = [
        candle
        for candle in candles
        if candle_time < candle.open_time <= end_time
    ]
    if not relevant:
        return ReviewResult("NO_DATA", 0.0, 0.0, 0.0, 0, None)

    for index, candle in enumerate(relevant):
        if side == "long":
            stop_hit = candle.low <= stop
            tp2_hit = candle.high >= take_profit_2
            tp1_hit = candle.high >= take_profit_1
        else:
            stop_hit = candle.high >= stop
            tp2_hit = candle.low <= take_profit_2
            tp1_hit = candle.low <= take_profit_1

        outcome = None
        r_multiple = 0.0
        if stop_hit:
            outcome, r_multiple = "STOP", -1.0
        elif tp2_hit:
            outcome, r_multiple = "TP2", 2.0
        elif tp1_hit:
            outcome, r_multiple = "TP1", 1.0

        if outcome:
            seen = relevant[: index + 1]
            mfe, mae = _excursions(side, entry_price, risk, seen)
            return ReviewResult(
                outcome, r_multiple, mfe, mae, len(seen), candle.close
            )

    mfe, mae = _excursions(side, entry_price, risk, relevant)
    last_close = relevant[-1].close
    unrealized = (
        (last_close - entry_price) / risk
        if side == "long"
        else (entry_price - last_close) / risk
    )
    return ReviewResult("OPEN", unrealized, mfe, mae, len(relevant), last_close)


def _excursions(
    side: str, entry_price: float, risk: float, candles: Sequence[Candle]
) -> tuple[float, float]:
    highest = max(candle.high for candle in candles)
    lowest = min(candle.low for candle in candles)
    if side == "long":
        return (highest - entry_price) / risk, (entry_price - lowest) / risk
    return (entry_price - lowest) / risk, (highest - entry_price) / risk
