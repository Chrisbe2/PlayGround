import unittest
from dataclasses import replace

from scalping_bot.config import Config
from scalping_bot.models import Candle
from scalping_bot.strategy import evaluate_symbol


def breakout_candles(volume: float = 300.0) -> list[Candle]:
    candles = []
    for index in range(100):
        close = 100 + index * 0.025 + (0.08 if index % 2 else -0.08)
        open_price = close - (0.04 if index % 2 else -0.04)
        candles.append(
            Candle(
                open_time=index * 300_000,
                open=open_price,
                high=max(open_price, close) + 0.08,
                low=min(open_price, close) - 0.08,
                close=close,
                volume=100.0,
                close_time=(index + 1) * 300_000 - 1,
                quote_volume=10_000.0,
            )
        )
    prior_resistance = max(item.high for item in candles[-49:-1])
    previous_close = candles[-2].close
    final_close = max(prior_resistance + 0.12, previous_close + 0.12)
    candles[-1] = Candle(
        open_time=candles[-1].open_time,
        open=previous_close + 0.02,
        high=final_close + 0.05,
        low=previous_close - 0.02,
        close=final_close,
        volume=volume,
        close_time=candles[-1].close_time,
        quote_volume=volume * final_close,
    )
    return candles


class StrategyTests(unittest.TestCase):
    def test_volume_confirmed_breakout_produces_risk_levels(self) -> None:
        config = Config(sr_lookback=20, min_score=0)
        signal = evaluate_symbol("TESTUSDT", breakout_candles(), config)
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertEqual(signal.side, "long")
        self.assertEqual(signal.setup, "Resistance breakout")
        self.assertLess(signal.stop, signal.entry)
        self.assertGreater(signal.take_profit_1, signal.entry)
        self.assertGreater(signal.take_profit_2, signal.take_profit_1)
        self.assertLess(signal.stop, signal.resistance)

    def test_low_volume_breakout_is_rejected(self) -> None:
        config = Config(sr_lookback=20, min_score=0)
        signal = evaluate_symbol("TESTUSDT", breakout_candles(volume=100), config)
        self.assertIsNone(signal)

    def test_shorts_are_disabled_by_default(self) -> None:
        config = Config()
        self.assertFalse(config.allow_shorts)
        self.assertFalse(replace(config, allow_shorts=False).allow_shorts)


if __name__ == "__main__":
    unittest.main()
