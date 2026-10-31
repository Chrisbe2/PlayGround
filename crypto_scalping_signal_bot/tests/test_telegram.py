import unittest
from unittest.mock import patch

import requests

from scalping_bot.telegram import TelegramNotifier, split_message


class FakeResponse:
    def __init__(self, status_code=200, payload=None, ok=None) -> None:
        self.status_code = status_code
        self._payload = {"ok": True} if payload is None else payload
        self.ok = status_code < 400 if ok is None else ok

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class TelegramTests(unittest.TestCase):
    def setUp(self) -> None:
        self.notifier = TelegramNotifier("token", "123", timeout=5)

    def test_short_message_is_sent_once(self) -> None:
        with patch("scalping_bot.telegram.requests.post") as post:
            post.return_value = FakeResponse()
            self.notifier.send("hello")
        post.assert_called_once()
        self.assertEqual(post.call_args.kwargs["data"]["chat_id"], "123")
        self.assertEqual(post.call_args.kwargs["data"]["text"], "hello")

    def test_long_message_is_split_on_line_boundaries(self) -> None:
        text = "\n".join(f"line {index:04d} " + "x" * 60 for index in range(100))
        chunks = split_message(text)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(chunk) <= 4096 for chunk in chunks))
        self.assertEqual("".join(chunks), text)

    def test_server_error_is_retried(self) -> None:
        with patch("scalping_bot.telegram.requests.post") as post, patch(
            "scalping_bot.telegram.time.sleep"
        ):
            post.side_effect = [FakeResponse(500, {"ok": False}), FakeResponse()]
            self.notifier.send("hello")
        self.assertEqual(post.call_count, 2)

    def test_rate_limit_honours_retry_after(self) -> None:
        payload = {"ok": False, "parameters": {"retry_after": 7}}
        with patch("scalping_bot.telegram.requests.post") as post, patch(
            "scalping_bot.telegram.time.sleep"
        ) as sleep, patch("scalping_bot.telegram.logger"):
            post.side_effect = [FakeResponse(429, payload), FakeResponse()]
            self.notifier.send("hello")
        sleep.assert_any_call(7)

    def test_rejected_message_fails_without_retry(self) -> None:
        payload = {"ok": False, "description": "Bad Request: chat not found"}
        with patch("scalping_bot.telegram.requests.post") as post:
            post.return_value = FakeResponse(400, payload)
            with self.assertRaises(RuntimeError):
                self.notifier.send("hello")
        self.assertEqual(post.call_count, 1)

    def test_network_error_is_retried_then_raised(self) -> None:
        with patch("scalping_bot.telegram.requests.post") as post, patch(
            "scalping_bot.telegram.time.sleep"
        ):
            post.side_effect = requests.ConnectionError("boom")
            with self.assertRaises(RuntimeError):
                self.notifier.send("hello")
        self.assertEqual(post.call_count, 3)


if __name__ == "__main__":
    unittest.main()
