from __future__ import annotations

import time
from dataclasses import dataclass, field

from .binance import BinanceClient
from .config import Config
from .models import Signal
from .strategy import evaluate_symbol


@dataclass
class ScanResult:
    symbols_scanned: int = 0
    signals: list[Signal] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


class MarketScanner:
    def __init__(self, config: Config, client: BinanceClient | None = None) -> None:
        self.config = config
        self.client = client or BinanceClient(config)

    def scan(self) -> ScanResult:
        result = ScanResult()
        symbols = self.client.liquid_usdt_symbols()
        for symbol in symbols:
            try:
                candles = self.client.closed_candles(symbol)
                signal = evaluate_symbol(symbol, candles, self.config)
                if signal:
                    result.signals.append(signal)
                result.symbols_scanned += 1
            except (RuntimeError, ValueError, KeyError, IndexError, TypeError) as exc:
                result.errors.append(f"{symbol}: {exc}")
            time.sleep(self.config.request_pause_seconds)
        result.signals.sort(key=lambda signal: signal.score, reverse=True)
        return result
