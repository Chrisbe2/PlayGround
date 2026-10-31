import unittest

from scalping_bot.indicators import atr, ema, rsi
from scalping_bot.models import Candle


def candle(index: int, price: float) -> Candle:
    return Candle(index, price, price + 1, price - 1, price, 100, index + 1, 100)


class IndicatorTests(unittest.TestCase):
    def test_ema_uses_sma_seed(self) -> None:
        values = ema([1, 2, 3, 4, 5], 3)
        self.assertIsNone(values[1])
        self.assertAlmostEqual(values[2], 2.0)
        self.assertAlmostEqual(values[3], 3.0)
        self.assertAlmostEqual(values[4], 4.0)

    def test_flat_rsi_is_neutral(self) -> None:
        values = rsi([10.0] * 30, 14)
        self.assertEqual(values[-1], 50.0)

    def test_rising_rsi_reaches_100(self) -> None:
        values = rsi(list(range(30)), 14)
        self.assertEqual(values[-1], 100.0)

    def test_constant_range_atr(self) -> None:
        candles = [candle(i, 10.0) for i in range(20)]
        values = atr(candles, 14)
        self.assertAlmostEqual(values[13], 2.0)
        self.assertAlmostEqual(values[-1], 2.0)


if __name__ == "__main__":
    unittest.main()
