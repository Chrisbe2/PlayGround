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

from scalping_bot.telegram_api import TelegramAPIError, collect_chats, get_updates


def _token() -> str:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    if token:
        return token
    token = getpass.getpass("Telegram bot token (input hidden): ").strip()
    if not token:
        raise SystemExit("No token provided.")
    return token


def main() -> int:
    token = _token()
    try:
        chats = collect_chats(get_updates(token))
    except TelegramAPIError as exc:
        print(exc, file=sys.stderr)
        return 1

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
