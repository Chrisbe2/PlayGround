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

    def test_journal_and_log_paths_come_from_environment(self) -> None:
        with patch.dict(
            os.environ,
            {"SIGNAL_JOURNAL_FILE": "custom.jsonl", "LOG_FILE": "bot.log"},
            clear=True,
        ):
            config = Config.from_env()
        self.assertEqual(config.journal_file, "custom.jsonl")
        self.assertEqual(config.log_file, "bot.log")

    def test_journal_can_be_disabled(self) -> None:
        with patch.dict(os.environ, {"SIGNAL_JOURNAL_FILE": ""}, clear=True):
            config = Config.from_env()
        self.assertEqual(config.journal_file, "")


if __name__ == "__main__":
    unittest.main()
