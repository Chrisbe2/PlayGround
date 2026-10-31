from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


@dataclass(frozen=True)
class Candle:
    open_time: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    close_time: int
    quote_volume: float

    @classmethod
    def from_binance(cls, row: list[Any]) -> "Candle":
        return cls(
            open_time=int(row[0]),
            open=float(row[1]),
            high=float(row[2]),
            low=float(row[3]),
            close=float(row[4]),
            volume=float(row[5]),
            close_time=int(row[6]),
            quote_volume=float(row[7]),
        )


@dataclass(frozen=True)
class Signal:
    symbol: str
    side: str
    setup: str
    candle_time: int
    entry: float
    stop: float
    take_profit_1: float
    take_profit_2: float
    atr: float
    rsi: float
    volume_ratio: float
    support: float
    resistance: float
    score: int
    reasons: tuple[str, ...]

    @property
    def cooldown_key(self) -> str:
        return f"{self.symbol}:{self.side}:{self.setup}"

    def to_message(self) -> str:
        side_label = "LONG" if self.side == "long" else "SHORT (not a spot trade)"
        candle_dt = datetime.fromtimestamp(self.candle_time / 1000, tz=timezone.utc)
        reasons = "\n".join(f"- {reason}" for reason in self.reasons)
        return (
            f"{side_label} | {self.symbol} | {self.setup}\n"
            f"Score: {self.score}/100 | Closed 5m candle: {candle_dt:%Y-%m-%d %H:%M} UTC\n\n"
            f"Reference entry: {self.entry:.8g}\n"
            f"Stop-loss: {self.stop:.8g}\n"
            f"Take-profit 1 (1R): {self.take_profit_1:.8g}\n"
            f"Take-profit 2 (2R): {self.take_profit_2:.8g}\n\n"
            f"ATR(14): {self.atr:.8g}\n"
            f"RSI(14): {self.rsi:.2f}\n"
            f"Volume vs prior 20-candle average: {self.volume_ratio:.2f}x\n"
            f"Support: {self.support:.8g} | Resistance: {self.resistance:.8g}\n\n"
            f"Confirmation:\n{reasons}\n\n"
            "Signal only. No order was placed. Validate prices, fees, slippage, "
            "and position size before making any decision."
        )
