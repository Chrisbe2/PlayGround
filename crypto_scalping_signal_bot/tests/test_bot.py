import logging
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from bot import run_scan
from scalping_bot.config import Config
from scalping_bot.journal import read_entries
from scalping_bot.models import Signal
from scalping_bot.scanner import ScanResult
from scalping_bot.state import SignalState


def signal() -> Signal:
    return Signal(
        symbol="BTCUSDT", side="long", setup="Resistance breakout",
        candle_time=1_700_000_000_000, entry=100, stop=98,
        take_profit_1=102, take_profit_2=104, atr=1, rsi=60,
        volume_ratio=2, support=95, resistance=99, score=80,
        reasons=("test reason",),
    )


class FakeScanner:
    def __init__(self, result: ScanResult) -> None:
        self.result = result

    def scan(self) -> ScanResult:
        return self.result


class BotTests(unittest.TestCase):
    def setUp(self) -> None:
        logging.disable(logging.CRITICAL)
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.journal = str(Path(self.folder.name) / "signals.jsonl")
        self.state_file = str(Path(self.folder.name) / "state.json")

    def tearDown(self) -> None:
        logging.disable(logging.NOTSET)

    def config(self, **overrides) -> Config:
        values = {
            "journal_file": self.journal,
            "state_file": self.state_file,
        }
        values.update(overrides)
        return Config(**values)

    def test_local_mode_journals_once_then_uses_cooldown(self) -> None:
        config = self.config()
        state = SignalState(config.state_file)
        scanner = FakeScanner(ScanResult(symbols_scanned=1, signals=[signal()]))

        self.assertEqual(run_scan(config, scanner, state), 0)
        self.assertEqual(run_scan(config, scanner, state), 0)

        entries = read_entries(self.journal)
        self.assertEqual(len(entries), 1)
        self.assertFalse(entries[0]["telegram_delivered"])
        self.assertTrue(state.on_cooldown(signal(), config.cooldown_minutes))

    def test_successful_telegram_delivery_is_journaled_as_sent(self) -> None:
        config = self.config(
            telegram_bot_token="token", telegram_chat_id="123"
        )
        state = SignalState(config.state_file)
        scanner = FakeScanner(ScanResult(symbols_scanned=1, signals=[signal()]))
        notifier = Mock()

        with patch("bot.TelegramNotifier", return_value=notifier):
            self.assertEqual(run_scan(config, scanner, state), 0)

        notifier.send.assert_called_once()
        entries = read_entries(self.journal)
        self.assertEqual(len(entries), 1)
        self.assertTrue(entries[0]["telegram_delivered"])

    def test_failed_delivery_is_retried_and_not_journaled(self) -> None:
        config = self.config(
            telegram_bot_token="token", telegram_chat_id="123"
        )
        state = SignalState(config.state_file)
        scanner = FakeScanner(ScanResult(symbols_scanned=1, signals=[signal()]))
        notifier = Mock()
        notifier.send.side_effect = RuntimeError("telegram down")

        with patch("bot.TelegramNotifier", return_value=notifier):
            self.assertEqual(run_scan(config, scanner, state), 0)

        self.assertEqual(read_entries(self.journal), [])
        self.assertFalse(state.on_cooldown(signal(), config.cooldown_minutes))

    def test_zero_scanned_symbols_returns_error_code(self) -> None:
        config = self.config()
        state = SignalState(config.state_file)
        scanner = FakeScanner(ScanResult(symbols_scanned=0))
        self.assertEqual(run_scan(config, scanner, state), 1)


if __name__ == "__main__":
    unittest.main()
