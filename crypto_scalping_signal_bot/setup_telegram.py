"""Link your Telegram bot in one command.

Usage:
    python3 setup_telegram.py

It reads TELEGRAM_BOT_TOKEN or prompts for it without echoing, prints the bot's
t.me link, waits for you to press Start, discovers the chat ID, writes
config.env with mode 600, and sends a test message. The token is never printed.
"""

from __future__ import annotations

import argparse
import getpass
import os
import shlex
import sys
import time
from pathlib import Path

from scalping_bot.telegram import TelegramNotifier
from scalping_bot.telegram_api import (
    TelegramAPIError,
    collect_chats,
    get_me,
    get_updates,
)

PROJECT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = PROJECT_DIR / "config.env"
EXAMPLE_CONFIG = PROJECT_DIR / "config.example.env"


def _token() -> str:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    if token:
        return token
    if not sys.stdin.isatty():
        raise SystemExit(
            "Set TELEGRAM_BOT_TOKEN in the environment or run this command interactively."
        )
    token = getpass.getpass("Telegram bot token (input hidden): ").strip()
    if not token:
        raise SystemExit("No token provided.")
    return token


def choose_chat(chats: dict[int, dict]) -> dict | None:
    if not chats:
        return None
    private = [chat for chat in chats.values() if chat.get("type") == "private"]
    return (private or list(chats.values()))[-1]


def chat_label(chat: dict) -> str:
    name = chat.get("title") or " ".join(
        part for part in (chat.get("first_name"), chat.get("last_name")) if part
    )
    username = f" (@{chat['username']})" if chat.get("username") else ""
    return f"{name or 'unnamed'}{username}"


def update_env(text: str, token: str, chat_id: int) -> str:
    lines = text.splitlines()
    output: list[str] = []
    seen_token = False
    seen_chat = False
    for line in lines:
        if line.startswith("TELEGRAM_BOT_TOKEN="):
            output.append(f"TELEGRAM_BOT_TOKEN={token}")
            seen_token = True
        elif line.startswith("TELEGRAM_CHAT_ID="):
            output.append(f"TELEGRAM_CHAT_ID={chat_id}")
            seen_chat = True
        else:
            output.append(line)
    if not seen_token:
        output.append(f"TELEGRAM_BOT_TOKEN={token}")
    if not seen_chat:
        output.append(f"TELEGRAM_CHAT_ID={chat_id}")
    return "\n".join(output).rstrip() + "\n"


def write_config(path: Path, token: str, chat_id: int) -> None:
    if path.exists():
        base = path.read_text(encoding="utf-8")
    elif EXAMPLE_CONFIG.exists():
        base = EXAMPLE_CONFIG.read_text(encoding="utf-8")
    else:
        base = ""
    updated = update_env(base, token, chat_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    descriptor = os.open(
        temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600
    )
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(updated)
    os.replace(temporary, path)
    os.chmod(path, 0o600)


def wait_for_chats(token: str, seconds: int) -> dict[int, dict]:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        chats = collect_chats(get_updates(token))
        if chats:
            return chats
        time.sleep(2)
    return {}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Link a Telegram bot to this scanner.")
    parser.add_argument(
        "--config", default=str(DEFAULT_CONFIG), help="Where to write credentials."
    )
    parser.add_argument(
        "--chat-id", type=int, help="Skip discovery and use this chat ID."
    )
    parser.add_argument(
        "--timeout", type=int, default=120, help="Seconds to wait for your message."
    )
    parser.add_argument("--no-test", action="store_true", help="Skip the test message.")
    args = parser.parse_args(argv)

    token = _token()
    try:
        me = get_me(token)
    except TelegramAPIError as exc:
        print(exc, file=sys.stderr)
        return 1

    username = me.get("username")
    name = me.get("first_name") or "your bot"
    if username:
        link = f"https://t.me/{username}"
        print(f"Bot:  {name} (@{username})")
        print(f"Link: {link}")
    else:
        link = ""
        print(f"Bot:  {name}")

    if args.chat_id is not None:
        chat_id = args.chat_id
        print(f"Using chat ID from --chat-id: {chat_id}")
    else:
        if link:
            print(f"\nOpen {link} and press Start, or send it any message.")
        else:
            print("\nOpen your bot in Telegram and send it any message.")
        print(f"Waiting up to {args.timeout} seconds for a chat...")
        try:
            chats = wait_for_chats(token, args.timeout)
        except TelegramAPIError as exc:
            print(exc, file=sys.stderr)
            return 1
        if not chats:
            print("No chat found. Press Start in the bot, then rerun this command.")
            return 2
        if len(chats) > 1:
            print("Chats found:")
            for candidate_id, chat in chats.items():
                print(f"  {candidate_id}  {chat_label(chat)}")
            print("Using the most recent private chat; use --chat-id to choose another.")
        chat = choose_chat(chats)
        assert chat is not None
        chat_id = int(chat["id"])
        print(f"Chat: {chat_id}  {chat_label(chat)}")

    config_path = Path(args.config)
    try:
        write_config(config_path, token, chat_id)
    except OSError as exc:
        print(f"Could not write {config_path}: {exc}", file=sys.stderr)
        return 1
    print(f"\nSaved credentials to {config_path} (mode 600).")

    if not args.no_test:
        try:
            TelegramNotifier(token, str(chat_id)).send(
                "Crypto signal bot linked successfully. "
                "This chat will receive signal-only alerts; no trading is connected."
            )
        except RuntimeError as exc:
            print(f"Test message failed: {exc}", file=sys.stderr)
            print("Credentials were saved. Fix the issue, then run:")
            print("  python3 bot.py --test-telegram")
            return 1
        print("Test message sent. Check Telegram.")

    quoted = shlex.quote(str(config_path))
    print("\nNext:")
    print(f"  set -a; source {quoted}; set +a")
    print("  python3 bot.py --status")
    print("  python3 bot.py --loop")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
