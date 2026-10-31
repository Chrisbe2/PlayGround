"""Replay journaled signals against later Binance candles.

Usage:
    python3 review_signals.py
    python3 review_signals.py --horizon 240 --since-days 7
    python3 review_signals.py --symbol BTCUSDT --limit 20

The reference entry is the signal candle's close, not a real fill. Ties inside
one candle count as the stop. Fees, spread, and slippage are not included.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from scalping_bot.binance import BinanceClient
from scalping_bot.config import Config
from scalping_bot.journal import read_entries
from scalping_bot.review import ReviewResult, evaluate_entry


def _entry_time(entry: dict[str, Any]) -> datetime | None:
    recorded = entry.get("recorded_at")
    if isinstance(recorded, str):
        try:
            parsed = datetime.fromisoformat(recorded)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    candle_time = entry.get("candle_time")
    if isinstance(candle_time, (int, float)):
        return datetime.fromtimestamp(candle_time / 1000, tz=timezone.utc)
    return None


def _format_row(entry: dict[str, Any], result: ReviewResult) -> str:
    return (
        f"{str(entry.get('symbol', '?')):12} "
        f"{str(entry.get('side', '?')).upper():5} "
        f"{str(entry.get('setup', '?')):22.22} "
        f"{float(entry.get('entry', 0)):<12.8g} "
        f"{result.outcome:8} "
        f"{result.r_multiple:+6.2f} "
        f"{result.mfe_r:+6.2f} "
        f"{result.mae_r:+6.2f}"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Review journaled signal outcomes.")
    parser.add_argument("--journal", help="Journal path (default: SIGNAL_JOURNAL_FILE).")
    parser.add_argument(
        "--horizon", type=int, default=240, help="Minutes to follow each signal (default 240)."
    )
    parser.add_argument("--since-days", type=float, help="Only entries newer than N days.")
    parser.add_argument("--symbol", help="Only this symbol, for example BTCUSDT.")
    parser.add_argument("--limit", type=int, default=0, help="Review only the newest N entries.")
    parser.add_argument("--json", action="store_true", help="Print JSON instead of a table.")
    args = parser.parse_args(argv)

    try:
        config = Config.from_env()
    except (ValueError, TypeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    journal = args.journal or config.journal_file
    entries = read_entries(journal)
    if args.symbol:
        wanted = args.symbol.upper()
        entries = [entry for entry in entries if entry.get("symbol") == wanted]
    if args.since_days is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(days=args.since_days)
        entries = [
            entry
            for entry in entries
            if (stamp := _entry_time(entry)) is not None and stamp >= cutoff
        ]
    if args.limit > 0:
        entries = entries[-args.limit :]

    if not entries:
        print(f"No journaled signals found in {journal or '(disabled)'}.")
        return 2

    client = BinanceClient(config)
    limit = min(1000, max(6, args.horizon // 5 + 2))
    results: list[tuple[dict[str, Any], ReviewResult]] = []
    for entry in entries:
        symbol = str(entry.get("symbol", ""))
        try:
            candle_time = int(entry["candle_time"])
            candles = client.closed_candles(
                symbol, start_time=candle_time + 1, limit=limit
            )
            result = evaluate_entry(entry, candles, args.horizon)
        except (RuntimeError, ValueError, KeyError, TypeError) as exc:
            print(f"WARNING: {symbol or '?'}: {exc}", file=sys.stderr)
            continue
        results.append((entry, result))
        time.sleep(config.request_pause_seconds)

    if not results:
        print("No signals could be reviewed.", file=sys.stderr)
        return 1

    if args.json:
        payload = [
            {
                "signal": entry,
                "outcome": result.outcome,
                "r_multiple": result.r_multiple,
                "mfe_r": result.mfe_r,
                "mae_r": result.mae_r,
                "candles_seen": result.candles_seen,
                "last_close": result.last_close,
            }
            for entry, result in results
        ]
        print(json.dumps(payload, indent=2))
        return 0

    print(f"Reviewed {len(results)} signal(s) from {journal} (horizon {args.horizon}m)\n")
    print(
        f"{'SYMBOL':12} {'SIDE':5} {'SETUP':22} {'ENTRY':12} "
        f"{'OUTCOME':8} {'R':>6} {'MFE':>6} {'MAE':>6}"
    )
    for entry, result in results:
        print(_format_row(entry, result))

    counts: dict[str, int] = {}
    for _, result in results:
        counts[result.outcome] = counts.get(result.outcome, 0) + 1
    resolved = counts.get("TP1", 0) + counts.get("TP2", 0) + counts.get("STOP", 0)
    wins = counts.get("TP1", 0) + counts.get("TP2", 0)
    win_rate = f"{wins / resolved:.1%}" if resolved else "n/a"
    total_r = sum(result.r_multiple for _, result in results)
    avg_r = total_r / len(results)

    summary = ", ".join(f"{key} {value}" for key, value in sorted(counts.items()))
    print(f"\nOutcomes: {summary}")
    print(
        f"Win rate (resolved): {win_rate} | "
        f"Total R: {total_r:+.2f} | Avg R: {avg_r:+.2f}"
    )
    print(
        "Reference entries are candle closes, not fills. Same-candle ties count "
        "as the stop. Fees, spread, and slippage are excluded."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
