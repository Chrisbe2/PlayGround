import os
import unittest
from unittest.mock import patch

from scalping_bot.config import Config


class ConfigTests(unittest.TestCase):
    def test_defaults_are_safe(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = Config.from_env()
        self.assertFalse(config.allow_shorts)
        self.assertFalse(config.telegram_configured)
        self.assertEqual(config.interval, "5m")

    def test_invalid_interval_is_rejected(self) -> None:
        with patch.dict(os.environ, {"SIGNAL_INTERVAL": "1m"}, clear=True):
            with self.assertRaises(ValueError):
                Config.from_env()


if __name__ == "__main__":
    unittest.main()
