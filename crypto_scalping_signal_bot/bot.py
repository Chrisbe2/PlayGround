from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone

from scalping_bot.binance import BinanceClient
from scalping_bot.config import Config
from scalping_bot.scanner import MarketScanner
from scalping_bot.state import SignalState
from scalping_bot.telegram import TelegramNotifier


def run_scan(config: Config, scanner: MarketScanner, state: SignalState) -> int:
    started = datetime.now(timezone.utc)
    print(f"[{started:%Y-%m-%d %H:%M:%S} UTC] Scanning liquid Binance USDT pairs...")
    result = scanner.scan()
    print(
        f"Scanned {result.symbols_scanned} pairs; "
        f"found {len(result.signals)} qualifying setup(s)."
    )
    for error in result.errors:
        print(f"WARNING: {error}", file=sys.stderr)

    notifier = None
    if config.telegram_configured:
        notifier = TelegramNotifier(
            config.telegram_bot_token,
            config.telegram_chat_id,
            config.request_timeout_seconds,
        )

    delivered = 0
    for signal in result.signals:
        if notifier and state.on_cooldown(signal, config.cooldown_minutes):
            print(f"Cooldown active: {signal.cooldown_key}")
            continue
        print("\n" + signal.to_message() + "\n")
        if notifier:
            notifier.send(signal.to_message())
            state.mark_sent(signal)
            delivered += 1
    if notifier:
        print(f"Telegram alerts sent: {delivered}")
    elif result.signals:
        print("Telegram is not configured; alerts were printed locally only.")
    if result.symbols_scanned == 0:
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Signal-only Binance scalping scanner with Telegram alerts."
    )
    parser.add_argument("--once", action="store_true", help="Run one scan (the default).")
    parser.add_argument("--loop", action="store_true", help="Scan continuously.")
    parser.add_argument("--ping", action="store_true", help="Test Binance connectivity and exit.")
    parser.add_argument(
        "--test-telegram", action="store_true", help="Send a Telegram test message and exit."
    )
    args = parser.parse_args()

    try:
        config = Config.from_env()
        if args.ping:
            BinanceClient(config).ping()
            print("Binance public API connection succeeded.")
            return 0
        if args.test_telegram:
            if not config.telegram_configured:
                print(
                    "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID first.", file=sys.stderr
                )
                return 2
            TelegramNotifier(
                config.telegram_bot_token,
                config.telegram_chat_id,
                config.request_timeout_seconds,
            ).send(
                "Crypto signal bot test succeeded. Alerts are signal-only; "
                "no trading is connected."
            )
            print("Telegram test message sent.")
            return 0

        scanner = MarketScanner(config)
        state = SignalState(config.state_file)
        if not args.loop:
            return run_scan(config, scanner, state)
        while True:
            try:
                run_scan(config, scanner, state)
            except RuntimeError as exc:
                print(f"Scan failed: {exc}", file=sys.stderr)
            print(f"Next scan in {config.loop_seconds} seconds.")
            time.sleep(config.loop_seconds)
    except KeyboardInterrupt:
        print("\nStopped.")
        return 0
    except (ValueError, RuntimeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
