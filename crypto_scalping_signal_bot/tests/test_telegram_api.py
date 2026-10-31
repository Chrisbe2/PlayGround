import unittest
from unittest.mock import patch

from scalping_bot.telegram_api import (
    TelegramAPIError,
    chat_from_update,
    collect_chats,
    get_me,
    get_updates,
)


class FakeResponse:
    def __init__(self, status_code=200, payload=None) -> None:
        self.status_code = status_code
        self._payload = payload if payload is not None else {"ok": True}

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class TelegramAPITests(unittest.TestCase):
    def test_get_me_returns_bot(self) -> None:
        payload = {"ok": True, "result": {"username": "my_bot"}}
        with patch("scalping_bot.telegram_api.requests.get") as get:
            get.return_value = FakeResponse(payload=payload)
            self.assertEqual(get_me("token"), {"username": "my_bot"})

    def test_get_updates_returns_list(self) -> None:
        payload = {"ok": True, "result": [{"update_id": 1}]}
        with patch("scalping_bot.telegram_api.requests.get") as get:
            get.return_value = FakeResponse(payload=payload)
            self.assertEqual(get_updates("token"), [{"update_id": 1}])

    def test_conflict_has_actionable_message(self) -> None:
        payload = {"ok": False, "description": "Conflict"}
        with patch("scalping_bot.telegram_api.requests.get") as get:
            get.return_value = FakeResponse(409, payload)
            with self.assertRaises(TelegramAPIError) as caught:
                get_updates("token")
        self.assertIn("bot.py --loop", str(caught.exception))

    def test_non_json_response_is_rejected(self) -> None:
        with patch("scalping_bot.telegram_api.requests.get") as get:
            get.return_value = FakeResponse(payload=ValueError("bad"))
            with self.assertRaises(TelegramAPIError):
                get_me("token")

    def test_collect_chats_handles_private_group_and_channel(self) -> None:
        updates = [
            {"message": {"chat": {"id": 1, "type": "private"}}},
            {"my_chat_member": {"chat": {"id": -2, "type": "group"}}},
            {"channel_post": {"chat": {"id": -3, "type": "channel"}}},
            {"edited_message": {"chat": {"id": 1, "type": "private"}}},
            {"message": {}},
        ]
        chats = collect_chats(updates)
        self.assertEqual(set(chats), {1, -2, -3})

    def test_chat_from_update_returns_none_for_unknown(self) -> None:
        self.assertIsNone(chat_from_update({"update_id": 9}))


if __name__ == "__main__":
    unittest.main()
