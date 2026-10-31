import tempfile
import unittest
from pathlib import Path

from scalping_bot.journal import append_signal, read_entries, signal_to_record
from scalping_bot.models import Signal


def signal(symbol: str = "BTCUSDT") -> Signal:
    return Signal(
        symbol=symbol, side="long", setup="Resistance breakout",
        candle_time=1_700_000_000_000, entry=100, stop=98,
        take_profit_1=102, take_profit_2=104, atr=1, rsi=60,
        volume_ratio=2, support=95, resistance=99, score=80,
        reasons=("test reason",),
    )


class JournalTests(unittest.TestCase):
    def test_append_and_read_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / "signals.jsonl")
            self.assertTrue(append_signal(path, signal(), delivered=True))
            self.assertTrue(append_signal(path, signal("ETHUSDT"), delivered=False))
            entries = read_entries(path)
            self.assertEqual(len(entries), 2)
            self.assertEqual(entries[0]["symbol"], "BTCUSDT")
            self.assertTrue(entries[0]["telegram_delivered"])
            self.assertFalse(entries[1]["telegram_delivered"])
            self.assertEqual(entries[0]["reasons"], ["test reason"])

    def test_malformed_lines_are_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "signals.jsonl"
            path.write_text(
                '{"symbol": "BTCUSDT"}\nnot json\n\n{"symbol": "ETHUSDT"}\n',
                encoding="utf-8",
            )
            entries = read_entries(str(path))
            self.assertEqual([entry["symbol"] for entry in entries], ["BTCUSDT", "ETHUSDT"])

    def test_disabled_journal_is_a_no_op(self) -> None:
        self.assertFalse(append_signal("", signal(), delivered=False))
        self.assertEqual(read_entries(""), [])

    def test_record_contains_reference_levels(self) -> None:
        record = signal_to_record(signal(), delivered=True)
        self.assertEqual(record["entry"], 100)
        self.assertEqual(record["stop"], 98)
        self.assertEqual(record["take_profit_1"], 102)
        self.assertEqual(record["take_profit_2"], 104)
        self.assertIn("recorded_at", record)


if __name__ == "__main__":
    unittest.main()
