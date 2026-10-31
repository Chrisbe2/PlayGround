from __future__ import annotations

import logging
import time

import requests

logger = logging.getLogger(__name__)

MAX_MESSAGE_LENGTH = 4096
MAX_ATTEMPTS = 3


def split_message(text: str, limit: int = MAX_MESSAGE_LENGTH) -> list[str]:
    """Split text into Telegram-sized chunks, preferring line boundaries."""
    if len(text) <= limit:
        return [text]
    chunks: list[str] = []
    current = ""
    for line in text.splitlines(keepends=True):
        while len(line) > limit:
            if current:
                chunks.append(current)
                current = ""
            chunks.append(line[:limit])
            line = line[limit:]
        if len(current) + len(line) > limit:
            chunks.append(current)
            current = ""
        current += line
    if current:
        chunks.append(current)
    return [chunk for chunk in chunks if chunk]


class TelegramNotifier:
    def __init__(self, token: str, chat_id: str, timeout: int = 15) -> None:
        self.token = token
        self.chat_id = chat_id
        self.timeout = timeout

    def send(self, text: str) -> None:
        for chunk in split_message(text):
            self._send_chunk(chunk)

    def _send_chunk(self, text: str) -> None:
        url = f"https://api.telegram.org/bot{self.token}/sendMessage"
        last_error: Exception | None = None
        for attempt in range(MAX_ATTEMPTS):
            try:
                response = requests.post(
                    url,
                    data={"chat_id": self.chat_id, "text": text},
                    timeout=self.timeout,
                )
            except requests.RequestException as exc:
                last_error = exc
                if attempt < MAX_ATTEMPTS - 1:
                    time.sleep(0.5 * (2**attempt))
                continue

            try:
                payload = response.json()
            except ValueError:
                payload = {}

            if response.status_code == 429:
                retry_after = _retry_after(payload)
                logger.warning("Telegram rate limit hit; retrying in %ss", retry_after)
                time.sleep(retry_after)
                last_error = RuntimeError("Telegram rate limit")
                continue

            if response.status_code >= 500:
                last_error = RuntimeError(f"Telegram server error {response.status_code}")
                if attempt < MAX_ATTEMPTS - 1:
                    time.sleep(0.5 * (2**attempt))
                continue

            if not response.ok or not payload.get("ok"):
                description = payload.get("description", "unknown error")
                raise RuntimeError(f"Telegram rejected the message: {description}")
            return

        raise RuntimeError(
            "Telegram delivery failed after retries. Check the token, chat ID, and network."
        ) from last_error


def _retry_after(payload: dict) -> int:
    parameters = payload.get("parameters")
    if isinstance(parameters, dict) and "retry_after" in parameters:
        try:
            return max(1, min(30, int(parameters["retry_after"])))
        except (TypeError, ValueError):
            pass
    return 1
