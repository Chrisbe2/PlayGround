"""Find the chat ID for your Telegram bot.

Usage:
    python3 get_chat_id.py

The token is read from TELEGRAM_BOT_TOKEN, or prompted for without echoing.
Open your bot in Telegram, send it a message, then run this script.
"""

from __future__ import annotations

import getpass
import os
import sys

import requests


def _token() -> str:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    if token:
        return token
    token = getpass.getpass("Telegram bot token (input hidden): ").strip()
    if not token:
        raise SystemExit("No token provided.")
    return token


def _chat_from_update(update: dict) -> dict | None:
    for key in ("message", "edited_message", "channel_post", "edited_channel_post"):
        payload = update.get(key)
        if isinstance(payload, dict) and isinstance(payload.get("chat"), dict):
            return payload["chat"]
    member = update.get("my_chat_member")
    if isinstance(member, dict) and isinstance(member.get("chat"), dict):
        return member["chat"]
    return None


def main() -> int:
    token = _token()
    try:
        response = requests.get(
            f"https://api.telegram.org/bot{token}/getUpdates",
            params={"timeout": 0, "limit": 100},
            timeout=20,
        )
        payload = response.json()
    except (requests.RequestException, ValueError) as exc:
        print(f"Could not reach Telegram: {exc}", file=sys.stderr)
        return 1

    if not payload.get("ok"):
        description = payload.get("description", "unknown error")
        print(f"Telegram rejected the request: {description}", file=sys.stderr)
        if response.status_code == 409:
            print(
                "Another process is polling this bot (for example bot.py --loop). "
                "Stop it, then run this script again.",
                file=sys.stderr,
            )
        return 1

    chats: dict[int, dict] = {}
    for update in payload.get("result", []):
        chat = _chat_from_update(update)
        if chat and "id" in chat:
            chats[int(chat["id"])] = chat

    if not chats:
        print("No chats found.")
        print("Open your bot in Telegram, press Start or send it any message, then rerun.")
        return 2

    print("Chat IDs found:")
    for chat_id, chat in chats.items():
        name = chat.get("title") or " ".join(
            part for part in (chat.get("first_name"), chat.get("last_name")) if part
        )
        username = f" (@{chat['username']})" if chat.get("username") else ""
        print(f"  {chat_id}  type={chat.get('type', '?')}  {name}{username}")

    print("\nUse the numeric ID as TELEGRAM_CHAT_ID. Keep it private.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
