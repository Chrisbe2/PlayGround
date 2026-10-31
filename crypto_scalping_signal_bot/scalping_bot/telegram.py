from __future__ import annotations

import requests


class TelegramNotifier:
    def __init__(self, token: str, chat_id: str, timeout: int = 15) -> None:
        self.token = token
        self.chat_id = chat_id
        self.timeout = timeout

    def send(self, text: str) -> None:
        url = f"https://api.telegram.org/bot{self.token}/sendMessage"
        try:
            response = requests.post(
                url,
                data={"chat_id": self.chat_id, "text": text},
                timeout=self.timeout,
            )
            response.raise_for_status()
            payload = response.json()
        except (requests.RequestException, ValueError) as exc:
            raise RuntimeError(
                "Telegram delivery failed. Check the token, chat ID, and network."
            ) from exc
        if not payload.get("ok"):
            raise RuntimeError("Telegram rejected the message. Check bot and chat permissions.")
