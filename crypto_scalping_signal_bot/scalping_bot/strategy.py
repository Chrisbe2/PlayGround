from __future__ import annotations

from collections.abc import Sequence

from .config import Config
from .indicators import atr, ema, rsi
from .models import Candle, Signal


def _finish_signal(
    symbol: str,
    side: str,
    setup: str,
    candle: Candle,
    stop_anchor: float,
    current_atr: float,
    current_rsi: float,
    volume_ratio: float,
    support: float,
    resistance: float,
    score: int,
    reasons: tuple[str, ...],
    config: Config,
) -> Signal | None:
    entry = candle.close
    initial_risk = config.stop_atr_multiple * current_atr
    if side == "long":
        stop = min(entry - initial_risk, stop_anchor)
        risk = entry - stop
        take_profit_1 = entry + risk
        take_profit_2 = entry + 2 * risk
    else:
        stop = max(entry + initial_risk, stop_anchor)
        risk = stop - entry
        take_profit_1 = entry - risk
        take_profit_2 = entry - 2 * risk
    if risk <= 0 or risk > 3.5 * current_atr or take_profit_1 <= 0:
        return None
    return Signal(
        symbol=symbol,
        side=side,
        setup=setup,
        candle_time=candle.close_time,
        entry=entry,
        stop=stop,
        take_profit_1=take_profit_1,
        take_profit_2=take_profit_2,
        atr=current_atr,
        rsi=current_rsi,
        volume_ratio=volume_ratio,
        support=support,
        resistance=resistance,
        score=min(100, round(score)),
        reasons=reasons,
    )


def evaluate_symbol(
    symbol: str, candles: Sequence[Candle], config: Config
) -> Signal | None:
    minimum = max(60, config.sr_lookback + 2, config.volume_period + 2)
    if len(candles) < minimum:
        return None

    closes = [candle.close for candle in candles]
    ema20 = ema(closes, 20)
    ema50 = ema(closes, 50)
    atr_values = atr(candles, config.atr_period)
    rsi_values = rsi(closes, config.rsi_period)
    current_atr = atr_values[-1]
    current_rsi = rsi_values[-1]
    fast = ema20[-1]
    slow = ema50[-1]
    if any(value is None for value in (current_atr, current_rsi, fast, slow)):
        return None

    current_atr = float(current_atr)
    current_rsi = float(current_rsi)
    fast = float(fast)
    slow = float(slow)
    current = candles[-1]
    previous = candles[-2]
    if current.close <= 0 or current_atr <= 0:
        return None
    atr_pct = current_atr / current.close
    if not config.min_atr_pct <= atr_pct <= config.max_atr_pct:
        return None

    volume_window = [candle.volume for candle in candles[-config.volume_period - 1 : -1]]
    average_volume = sum(volume_window) / len(volume_window)
    if average_volume <= 0:
        return None
    volume_ratio = current.volume / average_volume

    structure_window = candles[-config.sr_lookback - 1 : -1]
    support = min(candle.low for candle in structure_window)
    resistance = max(candle.high for candle in structure_window)
    trend_up = fast > slow
    trend_down = fast < slow
    trend_strength = abs(fast - slow) / current_atr
    candidates: list[Signal] = []

    def score(base: float) -> float:
        volume_points = min(12.0, max(0.0, (volume_ratio - 1.0) * 8.0))
        return base + volume_points + min(8.0, trend_strength * 4.0)

    if (
        trend_up
        and previous.close <= resistance < current.close
        and current.close - resistance <= current_atr
        and 50 <= current_rsi <= 72
        and volume_ratio >= config.min_volume_ratio
    ):
        reasons = (
            "Fresh close above prior resistance",
            "EMA20 is above EMA50",
            f"Volume is {volume_ratio:.2f}x its prior average",
            "RSI confirms momentum without using an overbought extreme",
        )
        signal = _finish_signal(
            symbol, "long", "Resistance breakout", current,
            resistance - 0.15 * current_atr, current_atr, current_rsi,
            volume_ratio, support, resistance, score(72), reasons, config,
        )
        if signal:
            candidates.append(signal)

    rejection_volume = max(1.2, config.min_volume_ratio * 0.8)
    candle_range = current.high - current.low
    strong_close = candle_range > 0 and (current.close - current.low) / candle_range >= 0.65
    if (
        trend_up
        and current.low <= support + 0.35 * current_atr
        and current.close > support
        and current.close > current.open
        and strong_close
        and 40 <= current_rsi <= 65
        and volume_ratio >= rejection_volume
    ):
        reasons = (
            "Price rejected the prior support area and closed bullish",
            "EMA20 is above EMA50",
            f"Volume is {volume_ratio:.2f}x its prior average",
            "Close is in the upper portion of the candle",
        )
        signal = _finish_signal(
            symbol, "long", "Support rejection", current,
            support - 0.15 * current_atr, current_atr, current_rsi,
            volume_ratio, support, resistance, score(68) + 3, reasons, config,
        )
        if signal:
            candidates.append(signal)

    if config.allow_shorts:
        if (
            trend_down
            and previous.close >= support > current.close
            and support - current.close <= current_atr
            and 28 <= current_rsi <= 50
            and volume_ratio >= config.min_volume_ratio
        ):
            reasons = (
                "Fresh close below prior support",
                "EMA20 is below EMA50",
                f"Volume is {volume_ratio:.2f}x its prior average",
                "RSI confirms bearish momentum without using an oversold extreme",
            )
            signal = _finish_signal(
                symbol, "short", "Support breakdown", current,
                support + 0.15 * current_atr, current_atr, current_rsi,
                volume_ratio, support, resistance, score(72), reasons, config,
            )
            if signal:
                candidates.append(signal)

        weak_close = candle_range > 0 and (current.high - current.close) / candle_range >= 0.65
        if (
            trend_down
            and current.high >= resistance - 0.35 * current_atr
            and current.close < resistance
            and current.close < current.open
            and weak_close
            and 35 <= current_rsi <= 60
            and volume_ratio >= rejection_volume
        ):
            reasons = (
                "Price rejected the prior resistance area and closed bearish",
                "EMA20 is below EMA50",
                f"Volume is {volume_ratio:.2f}x its prior average",
                "Close is in the lower portion of the candle",
            )
            signal = _finish_signal(
                symbol, "short", "Resistance rejection", current,
                resistance + 0.15 * current_atr, current_atr, current_rsi,
                volume_ratio, support, resistance, score(68) + 3, reasons, config,
            )
            if signal:
                candidates.append(signal)

    qualifying = [signal for signal in candidates if signal.score >= config.min_score]
    return max(qualifying, key=lambda signal: signal.score) if qualifying else None
