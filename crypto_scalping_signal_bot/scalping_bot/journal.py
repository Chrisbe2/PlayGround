from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .models import Signal

logger = logging.getLogger(__name__)


def signal_to_record(signal: Signal, delivered: bool) -> dict[str, Any]:
    return {
        "recorded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "symbol": signal.symbol,
        "side": signal.side,
        "setup": signal.setup,
        "candle_time": signal.candle_time,
        "entry": signal.entry,
        "stop": signal.stop,
        "take_profit_1": signal.take_profit_1,
        "take_profit_2": signal.take_profit_2,
        "atr": signal.atr,
        "rsi": signal.rsi,
        "volume_ratio": signal.volume_ratio,
        "support": signal.support,
        "resistance": signal.resistance,
        "score": signal.score,
        "reasons": list(signal.reasons),
        "telegram_delivered": delivered,
    }


def append_signal(path: str, signal: Signal, delivered: bool) -> bool:
    """Append one JSON line. Returns False when journaling is disabled or fails."""
    if not path:
        return False
    try:
        destination = Path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(signal_to_record(signal, delivered), separators=(",", ":"))
        with destination.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
        return True
    except OSError as exc:
        logger.warning("Could not write signal journal %s: %s", path, exc)
        return False


def read_entries(path: str) -> list[dict[str, Any]]:
    """Read a JSONL journal, skipping blank or malformed lines."""
    if not path:
        return []
    source = Path(path)
    if not source.exists():
        return []
    entries: list[dict[str, Any]] = []
    try:
        lines = source.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        logger.warning("Could not read signal journal %s: %s", path, exc)
        return []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict):
            entries.append(record)
    return entries
