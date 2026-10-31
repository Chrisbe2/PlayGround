import tempfile
import unittest
from pathlib import Path

from scalping_bot.models import Signal
from scalping_bot.state import SignalState


def signal() -> Signal:
    return Signal(
        symbol="BTCUSDT", side="long", setup="Resistance breakout",
        candle_time=1, entry=100, stop=98, take_profit_1=102,
        take_profit_2=104, atr=1, rsi=60, volume_ratio=2,
        support=95, resistance=99, score=80, reasons=("test",),
    )


class StateTests(unittest.TestCase):
    def test_cooldown_persists(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / "state.json")
            state = SignalState(path)
            item = signal()
            self.assertFalse(state.on_cooldown(item, 60))
            state.mark_sent(item)
            restored = SignalState(path)
            self.assertTrue(restored.on_cooldown(item, 60))

    def test_corrupt_state_is_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            path.write_text("not json", encoding="utf-8")
            state = SignalState(str(path))
            self.assertEqual(state.last_sent, {})

    def test_unwritable_state_does_not_raise(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            state = SignalState(folder)
            state.mark_sent(signal())
            self.assertTrue(state.on_cooldown(signal(), 60))


if __name__ == "__main__":
    unittest.main()
