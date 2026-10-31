from __future__ import annotations

import os
from dataclasses import dataclass


def _float(name: str, default: float) -> float:
    return float(os.getenv(name, default))


def _int(name: str, default: int) -> int:
    return int(os.getenv(name, default))


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Config:
    binance_base_url: str = "https://api.binance.com"
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    interval: str = "5m"
    kline_limit: int = 180
    max_symbols: int = 40
    min_quote_volume: float = 10_000_000.0
    request_pause_seconds: float = 0.12
    request_timeout_seconds: int = 15
    atr_period: int = 14
    rsi_period: int = 14
    volume_period: int = 20
    sr_lookback: int = 48
    min_volume_ratio: float = 1.5
    min_atr_pct: float = 0.0005
    max_atr_pct: float = 0.03
    min_score: int = 70
    stop_atr_multiple: float = 1.5
    cooldown_minutes: int = 60
    loop_seconds: int = 300
    allow_shorts: bool = False
    state_file: str = "state.json"
    journal_file: str = "signals.jsonl"
    log_file: str = ""

    @classmethod
    def from_env(cls) -> "Config":
        config = cls(
            binance_base_url=os.getenv("BINANCE_BASE_URL", cls.binance_base_url).rstrip("/"),
            telegram_bot_token=os.getenv("TELEGRAM_BOT_TOKEN", "").strip(),
            telegram_chat_id=os.getenv("TELEGRAM_CHAT_ID", "").strip(),
            interval=os.getenv("SIGNAL_INTERVAL", cls.interval),
            kline_limit=_int("KLINE_LIMIT", cls.kline_limit),
            max_symbols=_int("MAX_SYMBOLS", cls.max_symbols),
            min_quote_volume=_float("MIN_24H_QUOTE_VOLUME", cls.min_quote_volume),
            request_pause_seconds=_float("REQUEST_PAUSE_SECONDS", cls.request_pause_seconds),
            request_timeout_seconds=_int("REQUEST_TIMEOUT_SECONDS", cls.request_timeout_seconds),
            min_volume_ratio=_float("MIN_VOLUME_RATIO", cls.min_volume_ratio),
            min_atr_pct=_float("MIN_ATR_PCT", cls.min_atr_pct),
            max_atr_pct=_float("MAX_ATR_PCT", cls.max_atr_pct),
            min_score=_int("MIN_SIGNAL_SCORE", cls.min_score),
            stop_atr_multiple=_float("STOP_ATR_MULTIPLE", cls.stop_atr_multiple),
            cooldown_minutes=_int("SIGNAL_COOLDOWN_MINUTES", cls.cooldown_minutes),
            loop_seconds=_int("SCAN_INTERVAL_SECONDS", cls.loop_seconds),
            allow_shorts=_bool("ALLOW_SHORTS", cls.allow_shorts),
            state_file=os.getenv("SIGNAL_STATE_FILE", cls.state_file).strip(),
            journal_file=os.getenv("SIGNAL_JOURNAL_FILE", cls.journal_file).strip(),
            log_file=os.getenv("LOG_FILE", cls.log_file).strip(),
        )
        config.validate()
        return config

    def validate(self) -> None:
        if self.interval != "5m":
            raise ValueError("This version is validated for SIGNAL_INTERVAL=5m only.")
        if not 80 <= self.kline_limit <= 1000:
            raise ValueError("KLINE_LIMIT must be between 80 and 1000.")
        if not 1 <= self.max_symbols <= 200:
            raise ValueError("MAX_SYMBOLS must be between 1 and 200.")
        if self.min_quote_volume < 0:
            raise ValueError("MIN_24H_QUOTE_VOLUME cannot be negative.")
        if self.sr_lookback < 10 or self.volume_period < 5:
            raise ValueError("Support/resistance lookback or volume period is too short.")
        if self.min_atr_pct <= 0 or self.max_atr_pct <= self.min_atr_pct:
            raise ValueError("ATR percentage bounds are invalid.")
        if not 0 <= self.min_score <= 100:
            raise ValueError("MIN_SIGNAL_SCORE must be between 0 and 100.")
        if self.stop_atr_multiple <= 0:
            raise ValueError("STOP_ATR_MULTIPLE must be positive.")
        if self.loop_seconds < 60:
            raise ValueError("SCAN_INTERVAL_SECONDS must be at least 60.")

    @property
    def telegram_configured(self) -> bool:
        return bool(self.telegram_bot_token and self.telegram_chat_id)
