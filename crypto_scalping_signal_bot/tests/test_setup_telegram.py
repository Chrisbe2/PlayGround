import io
import os
import stat
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from setup_telegram import (
    chat_label,
    choose_chat,
    main,
    update_env,
    write_config,
)


class SetupHelperTests(unittest.TestCase):
    def test_update_env_replaces_existing_values(self) -> None:
        text = (
            "# comment\n"
            "TELEGRAM_BOT_TOKEN=old\n"
            "MAX_SYMBOLS=10\n"
            "TELEGRAM_CHAT_ID=old\n"
        )
        updated = update_env(text, "new-token", 12345)
        self.assertIn("TELEGRAM_BOT_TOKEN=new-token", updated)
        self.assertIn("TELEGRAM_CHAT_ID=12345", updated)
        self.assertIn("MAX_SYMBOLS=10", updated)
        self.assertIn("# comment", updated)
        self.assertEqual(updated.count("TELEGRAM_BOT_TOKEN="), 1)

    def test_update_env_appends_missing_values(self) -> None:
        updated = update_env("MAX_SYMBOLS=10\n", "token", -100)
        self.assertIn("MAX_SYMBOLS=10", updated)
        self.assertIn("TELEGRAM_BOT_TOKEN=token", updated)
        self.assertIn("TELEGRAM_CHAT_ID=-100", updated)

    def test_choose_chat_prefers_private_chat(self) -> None:
        chats = {
            -100: {"id": -100, "type": "group", "title": "Group"},
            42: {"id": 42, "type": "private", "first_name": "Ada"},
        }
        chosen = choose_chat(chats)
        self.assertIsNotNone(chosen)
        assert chosen is not None
        self.assertEqual(chosen["id"], 42)

    def test_chat_label_includes_username(self) -> None:
        label = chat_label(
            {"type": "private", "first_name": "Ada", "username": "ada"}
        )
        self.assertEqual(label, "Ada (@ada)")

    def test_write_config_creates_private_file(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.env"
            write_config(path, "secret-token", 99)
            text = path.read_text(encoding="utf-8")
            self.assertIn("TELEGRAM_BOT_TOKEN=secret-token", text)
            self.assertIn("TELEGRAM_CHAT_ID=99", text)
            mode = stat.S_IMODE(os.stat(path).st_mode)
            self.assertEqual(mode, 0o600)

    def test_write_config_preserves_existing_settings(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.env"
            path.write_text("MAX_SYMBOLS=7\nTELEGRAM_BOT_TOKEN=old\n", encoding="utf-8")
            write_config(path, "new", 5)
            text = path.read_text(encoding="utf-8")
            self.assertIn("MAX_SYMBOLS=7", text)
            self.assertIn("TELEGRAM_BOT_TOKEN=new", text)
            self.assertIn("TELEGRAM_CHAT_ID=5", text)


class SetupFlowTests(unittest.TestCase):
    def test_main_links_bot_and_writes_config(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.env"
            chat = {"id": 42, "type": "private", "first_name": "Ada"}
            with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "token"}), patch(
                "setup_telegram.get_me",
                return_value={"username": "my_bot", "first_name": "My"},
            ), patch(
                "setup_telegram.wait_for_chats", return_value={42: chat}
            ), patch(
                "setup_telegram.TelegramNotifier"
            ) as notifier, redirect_stdout(io.StringIO()):
                code = main(["--config", str(path)])

            self.assertEqual(code, 0)
            text = path.read_text(encoding="utf-8")
            self.assertIn("TELEGRAM_BOT_TOKEN=token", text)
            self.assertIn("TELEGRAM_CHAT_ID=42", text)
            notifier.return_value.send.assert_called_once()

    def test_main_without_a_chat_returns_two(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.env"
            with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "token"}), patch(
                "setup_telegram.get_me",
                return_value={"username": "my_bot", "first_name": "My"},
            ), patch("setup_telegram.wait_for_chats", return_value={}), redirect_stdout(
                io.StringIO()
            ):
                code = main(["--config", str(path), "--timeout", "1"])

            self.assertEqual(code, 2)
            self.assertFalse(path.exists())

    def test_chat_id_option_skips_discovery(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.env"
            with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "token"}), patch(
                "setup_telegram.get_me",
                return_value={"username": "my_bot", "first_name": "My"},
            ), patch("setup_telegram.wait_for_chats") as wait, patch(
                "setup_telegram.TelegramNotifier"
            ), redirect_stdout(io.StringIO()):
                code = main(["--config", str(path), "--chat-id", "-100"])

            self.assertEqual(code, 0)
            wait.assert_not_called()
            self.assertIn(
                "TELEGRAM_CHAT_ID=-100", path.read_text(encoding="utf-8")
            )


if __name__ == "__main__":
    unittest.main()
