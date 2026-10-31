import unittest

from scalping_bot.models import Candle
from scalping_bot.review import evaluate_entry


def candle(open_time: int, high: float, low: float, close: float) -> Candle:
    return Candle(
        open_time=open_time,
        open=close,
        high=high,
        low=low,
        close=close,
        volume=100.0,
        close_time=open_time + 299_999,
        quote_volume=10_000.0,
    )


def long_entry(**overrides) -> dict:
    entry = {
        "symbol": "TESTUSDT",
        "side": "long",
        "setup": "Resistance breakout",
        "candle_time": 0,
        "entry": 100.0,
        "stop": 98.0,
        "take_profit_1": 102.0,
        "take_profit_2": 104.0,
    }
    entry.update(overrides)
    return entry


class ReviewTests(unittest.TestCase):
    def test_long_reaches_tp2(self) -> None:
        result = evaluate_entry(
            long_entry(), [candle(300_000, high=105, low=99, close=104)]
        )
        self.assertEqual(result.outcome, "TP2")
        self.assertEqual(result.r_multiple, 2.0)
        self.assertAlmostEqual(result.mfe_r, 2.5)
        self.assertAlmostEqual(result.mae_r, 0.5)

    def test_same_candle_stop_wins_conservatively(self) -> None:
        result = evaluate_entry(
            long_entry(), [candle(300_000, high=105, low=97, close=100)]
        )
        self.assertEqual(result.outcome, "STOP")
        self.assertEqual(result.r_multiple, -1.0)

    def test_open_position_uses_last_close(self) -> None:
        result = evaluate_entry(
            long_entry(),
            [
                candle(300_000, high=101, low=99, close=100.5),
                candle(600_000, high=101, low=99.5, close=100.5),
            ],
        )
        self.assertEqual(result.outcome, "OPEN")
        self.assertAlmostEqual(result.r_multiple, 0.25)
        self.assertEqual(result.candles_seen, 2)

    def test_short_reaches_tp1(self) -> None:
        entry = long_entry(
            side="short", stop=102.0, take_profit_1=98.0, take_profit_2=96.0
        )
        result = evaluate_entry(entry, [candle(300_000, high=101, low=97, close=98)])
        self.assertEqual(result.outcome, "TP1")
        self.assertEqual(result.r_multiple, 1.0)
        self.assertAlmostEqual(result.mfe_r, 1.5)
        self.assertAlmostEqual(result.mae_r, 0.5)

    def test_no_later_candles_returns_no_data(self) -> None:
        result = evaluate_entry(long_entry(), [candle(0, high=105, low=99, close=104)])
        self.assertEqual(result.outcome, "NO_DATA")
        self.assertIsNone(result.last_close)

    def test_candles_beyond_horizon_are_ignored(self) -> None:
        result = evaluate_entry(
            long_entry(), [candle(300_000 * 60, high=105, low=99, close=104)],
            horizon_minutes=240,
        )
        self.assertEqual(result.outcome, "NO_DATA")

    def test_zero_risk_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            evaluate_entry(long_entry(stop=100.0), [])


if __name__ == "__main__":
    unittest.main()
