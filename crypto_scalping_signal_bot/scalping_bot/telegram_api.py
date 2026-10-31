from __future__ import annotations

import requests


class TelegramAPIError(RuntimeError):
    pass


def _call(
    token: str, method: str, params: dict | None = None, timeout: int = 20
) -> object:
    url = f"https://api.telegram.org/bot{token}/{method}"
    try:
        response = requests.get(url, params=params, timeout=timeout)
    except requests.RequestException as exc:
        raise TelegramAPIError(f"Could not reach Telegram: {exc}") from exc
    try:
        payload = response.json()
    except ValueError as exc:
        raise TelegramAPIError("Telegram returned a non-JSON response.") from exc
    if not payload.get("ok"):
        description = payload.get("description", "unknown error")
        if response.status_code == 409:
            raise TelegramAPIError(
                "Another process is polling this bot. Stop bot.py --loop, then retry."
            )
        raise TelegramAPIError(f"Telegram rejected the request: {description}")
    return payload.get("result")


def get_me(token: str, timeout: int = 20) -> dict:
    result = _call(token, "getMe", timeout=timeout)
    return result if isinstance(result, dict) else {}


def get_updates(token: str, timeout: int = 20) -> list[dict]:
    result = _call(
        token, "getUpdates", {"timeout": 0, "limit": 100}, timeout=timeout
    )
    return result if isinstance(result, list) else []


def chat_from_update(update: dict) -> dict | None:
    for key in ("message", "edited_message", "channel_post", "edited_channel_post"):
        payload = update.get(key)
        if isinstance(payload, dict) and isinstance(payload.get("chat"), dict):
            return payload["chat"]
    member = update.get("my_chat_member")
    if isinstance(member, dict) and isinstance(member.get("chat"), dict):
        return member["chat"]
    return None


def collect_chats(updates: list[dict]) -> dict[int, dict]:
    chats: dict[int, dict] = {}
    for update in updates:
        chat = chat_from_update(update)
        if chat and "id" in chat:
            chats[int(chat["id"])] = chat
    return chats
