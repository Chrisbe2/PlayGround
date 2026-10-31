from __future__ import annotations

import json
import time
from pathlib import Path

from .models import Signal


class SignalState:
    def __init__(self, path: str) -> None:
        self.path = Path(path)
        self.last_sent: dict[str, float] = {}
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                self.last_sent = {
                    str(key): float(value)
                    for key, value in data.get("last_sent", {}).items()
                }
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                self.last_sent = {}

    def on_cooldown(self, signal: Signal, cooldown_minutes: int) -> bool:
        previous = self.last_sent.get(signal.cooldown_key)
        return previous is not None and time.time() - previous < cooldown_minutes * 60

    def mark_sent(self, signal: Signal) -> None:
        self.last_sent[signal.cooldown_key] = time.time()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary.write_text(
            json.dumps({"last_sent": self.last_sent}, indent=2), encoding="utf-8"
        )
        temporary.replace(self.path)
