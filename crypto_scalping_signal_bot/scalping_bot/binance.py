from __future__ import annotations

import time
from typing import Any

import requests

from .config import Config
from .models import Candle


class BinanceClient:
    def __init__(self, config: Config, session: requests.Session | None = None) -> None:
        self.config = config
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": "crypto-scalping-signal-bot/1.0"})

    def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        url = f"{self.config.binance_base_url}{path}"
        last_error: requests.RequestException | None = None
        for attempt in range(3):
            try:
                response = self.session.get(
                    url,
                    params=params,
                    timeout=self.config.request_timeout_seconds,
                )
                response.raise_for_status()
                return response.json()
            except requests.RequestException as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(0.5 * (2**attempt))
        raise RuntimeError(f"Binance public data request failed: {path}") from last_error

    def ping(self) -> None:
        self._get("/api/v3/ping")

    def liquid_usdt_symbols(self) -> list[str]:
        exchange_info = self._get("/api/v3/exchangeInfo")
        tickers = self._get("/api/v3/ticker/24hr")
        volumes = {
            item["symbol"]: float(item.get("quoteVolume", 0))
            for item in tickers
            if isinstance(item, dict) and "symbol" in item
        }
        excluded_bases = {
            "USDC", "FDUSD", "TUSD", "USDP", "DAI", "USD1", "AEUR", "EURI"
        }
        candidates: list[tuple[str, float]] = []
        for item in exchange_info.get("symbols", []):
            symbol = item.get("symbol", "")
            base = item.get("baseAsset", "")
            if item.get("status") != "TRADING" or item.get("quoteAsset") != "USDT":
                continue
            if item.get("isSpotTradingAllowed") is False:
                continue
            if base in excluded_bases or base.endswith(("UP", "DOWN", "BULL", "BEAR")):
                continue
            quote_volume = volumes.get(symbol, 0.0)
            if quote_volume >= self.config.min_quote_volume:
                candidates.append((symbol, quote_volume))
        candidates.sort(key=lambda pair: pair[1], reverse=True)
        return [symbol for symbol, _ in candidates[: self.config.max_symbols]]

    def closed_candles(self, symbol: str) -> list[Candle]:
        rows = self._get(
            "/api/v3/klines",
            {
                "symbol": symbol,
                "interval": self.config.interval,
                "limit": self.config.kline_limit,
            },
        )
        now_ms = int(time.time() * 1000)
        candles = [Candle.from_binance(row) for row in rows]
        return [candle for candle in candles if candle.close_time <= now_ms]
