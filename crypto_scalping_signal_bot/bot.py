from __future__ import annotations

import argparse
import logging
import sys
import time
from datetime import datetime, timezone
from typing import Any

from scalping_bot.binance import BinanceClient
from scalping_bot.config import Config
from scalping_bot.journal import append_signal, read_entries
from scalping_bot.logging_setup import configure_logging
from scalping_bot.scanner import MarketScanner
from scalping_bot.state import SignalState
from scalping_bot.telegram import TelegramNotifier

logger = logging.getLogger("bot")


def run_scan(config: Config, scanner: MarketScanner, state: SignalState) -> int:
    started = datetime.now(timezone.utc)
    logger.info("Scanning liquid Binance USDT pairs...")
    result = scanner.scan()
    logger.info(
        "Scanned %d pairs; found %d qualifying setup(s).",
        result.symbols_scanned,
        len(result.signals),
    )
    for error in result.errors:
        logger.warning("%s", error)

    notifier = None
    if config.telegram_configured:
        notifier = TelegramNotifier(
            config.telegram_bot_token,
            config.telegram_chat_id,
            config.request_timeout_seconds,
        )

    delivered = 0
    failed = 0
    for signal in result.signals:
        if state.on_cooldown(signal, config.cooldown_minutes):
            logger.info("Cooldown active: %s", signal.cooldown_key)
            continue
        logger.info("\n%s", signal.to_message())
        if notifier:
            try:
                notifier.send(signal.to_message())
            except RuntimeError as exc:
                failed += 1
                logger.error(
                    "Telegram delivery failed for %s: %s (will retry next scan)",
                    signal.symbol,
                    exc,
                )
                continue
            delivered += 1
        state.mark_sent(signal)
        append_signal(config.journal_file, signal, notifier is not None)

    if notifier:
        logger.info("Telegram alerts sent: %d (failed: %d)", delivered, failed)
    elif result.signals:
        logger.info("Telegram is not configured; alerts were printed locally only.")
    if result.symbols_scanned == 0:
        logger.error("No symbols were scanned; check Binance connectivity and filters.")
        return 1
    return 0


def print_status(config: Config) -> int:
    print("Crypto Scalping Signal Bot")
    print(f"  Binance URL:        {config.binance_base_url}")
    print(f"  Telegram:           {'configured' if config.telegram_configured else 'not configured'}")
    print(f"  Interval:           {config.interval}")
    print(f"  Max symbols:        {config.max_symbols}")
    print(f"  Min 24h volume:     {config.min_quote_volume:,.0f} USDT")
    print(f"  Min signal score:   {config.min_score}/100")
    print(f"  Cooldown:           {config.cooldown_minutes} minutes")
    print(f"  Loop interval:      {config.loop_seconds} seconds")
    print(f"  Shorts enabled:     {'yes' if config.allow_shorts else 'no'}")
    print(f"  State file:         {config.state_file}")
    print(f"  Journal file:       {config.journal_file or '(disabled)'}")
    print(f"  Log file:           {config.log_file or '(console only)'}")

    entries = read_entries(config.journal_file)
    print(f"\nJournaled signals: {len(entries)}")
    for entry in entries[-5:]:
        print(f"  {_describe_entry(entry)}")

    state = SignalState(config.state_file)
    print(f"Active cooldown keys: {len(state.last_sent)}")
    return 0


def _describe_entry(entry: dict[str, Any]) -> str:
    recorded = str(entry.get("recorded_at", "?"))[:19].replace("T", " ")
    symbol = entry.get("symbol", "?")
    side = str(entry.get("side", "?")).upper()
    setup = entry.get("setup", "?")
    score = entry.get("score", "?")
    delivered = "sent" if entry.get("telegram_delivered") else "local"
    return f"{recorded} UTC | {side:5} {symbol:12} | {setup} | {score}/100 | {delivered}"


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
    parser.add_argument(
        "--status", action="store_true", help="Show configuration and recent signals, then exit."
    )
    args = parser.parse_args()

    try:
        config = Config.from_env()
    except (ValueError, TypeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    configure_logging(config.log_file)

    try:
        if args.ping:
            BinanceClient(config).ping()
            logger.info("Binance public API connection succeeded.")
            return 0
        if args.test_telegram:
            if not config.telegram_configured:
                logger.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID first.")
                return 2
            TelegramNotifier(
                config.telegram_bot_token,
                config.telegram_chat_id,
                config.request_timeout_seconds,
            ).send(
                "Crypto signal bot test succeeded. Alerts are signal-only; "
                "no trading is connected."
            )
            logger.info("Telegram test message sent.")
            return 0
        if args.status:
            return print_status(config)

        scanner = MarketScanner(config)
        state = SignalState(config.state_file)
        if not args.loop:
            return run_scan(config, scanner, state)
        while True:
            try:
                run_scan(config, scanner, state)
            except RuntimeError as exc:
                logger.error("Scan failed: %s", exc)
            logger.info("Next scan in %d seconds.", config.loop_seconds)
            time.sleep(config.loop_seconds)
    except KeyboardInterrupt:
        logger.info("Stopped.")
        return 0
    except (ValueError, RuntimeError) as exc:
        logger.error("%s", exc)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
