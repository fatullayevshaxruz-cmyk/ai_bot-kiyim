"""Integratsiya testi: parser yozgan mahsulot Web App API'sida ko'rinadimi?

Serversiz ishlaydi — server javob bermasa test `skip` bo'ladi.
Test tugagach o'z yozuvlarini bazadan tozalaydi.
"""

from __future__ import annotations

import json
import random
import unittest
import urllib.request
import uuid

from parser import store
from parser.captions import ParsedCaption
from parser.config import settings

BASE_URL = "http://127.0.0.1:8080"
CHAT_ID = "-100999"


def _get_json(path: str):
    with urllib.request.urlopen(f"{BASE_URL}{path}", timeout=5) as response:
        return json.load(response)


class CatalogApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            health = _get_json("/api/health")
            if health.get("ok") is not True:
                raise unittest.SkipTest("server health javobi noto'g'ri")
        except Exception as exc:  # server o'chirilgan bo'lsa test o'tkazib yuboriladi
            raise unittest.SkipTest(f"server ishlamayapti: {exc}")

        cls.connection = store.connect(settings.db_path)
        cls.addClassCleanup(cls.connection.close)
        cls.title = f"Parser test {uuid.uuid4().hex[:6]}"
        cls.msg_id = random.randint(1_000_000, 9_000_000)
        cls.product_id = None

        def cleanup():
            if cls.product_id:
                cls.connection.execute("DELETE FROM products WHERE id = ?", (cls.product_id,))
            cls.connection.execute("DELETE FROM parsed_posts WHERE chat_id = ?", (CHAT_ID,))
            cls.connection.commit()

        cls.addClassCleanup(cleanup)

    def test_product_created_by_parser_is_visible_in_catalog(self):
        parsed = ParsedCaption(
            title=self.title,
            price=1234000,
            sizes=["M", "L"],
            description="Parser orqali qo'shilgan sinov mahsuloti.",
            category_slug="casual",
            badge="Yangi",
        )
        result = store.save_product(
            self.connection,
            chat_id=CHAT_ID,
            msg_id=self.msg_id,
            parsed=parsed,
            images=["/uploads/seed-klassik-kostyum-atlas-1.svg"],
            category_slug="casual",
            source_url=f"https://t.me/c/999/{self.msg_id}",
            posted_at="2026-11-01T10:00:00+00:00",
        )
        self.assertEqual(result.action, "created")
        type(self).product_id = result.product_id

        data = _get_json("/api/bootstrap")
        product = next((item for item in data["products"] if item["id"] == result.product_id), None)
        self.assertIsNotNone(product, "mahsulot /api/bootstrap da ko'rinmadi")
        self.assertEqual(product["title"], self.title)
        self.assertEqual(product["price"], 1234000)
        self.assertEqual(product["sizes"], ["M", "L"])
        self.assertEqual(product["images"], ["/uploads/seed-klassik-kostyum-atlas-1.svg"])

        # Qayta sync — dublikat yaratmaydi.
        again = store.save_product(
            self.connection,
            chat_id=CHAT_ID,
            msg_id=self.msg_id,
            parsed=parsed,
            images=[],
            category_slug="casual",
        )
        self.assertEqual(again.action, "unchanged")
        self.assertEqual(again.product_id, result.product_id)

    def test_deleted_channel_post_disappears_from_catalog(self):
        """Kanalda post o'chirilsa mahsulot Web App katalogidan ham yo'qoladi."""
        msg_id = self.msg_id + 1
        title = f"O'chirish testi {uuid.uuid4().hex[:6]}"
        parsed = ParsedCaption(
            title=title,
            price=990000,
            sizes=[],
            description="",
            category_slug="casual",
            badge="",
        )
        result = store.save_product(
            self.connection,
            chat_id=CHAT_ID,
            msg_id=msg_id,
            parsed=parsed,
            images=["/uploads/seed-klassik-kostyum-atlas-1.svg"],
            category_slug="casual",
            source_url=f"https://t.me/c/999/{msg_id}",
            posted_at="2026-11-02T10:00:00+00:00",
        )
        try:
            self.assertEqual(result.action, "created")
            visible = _get_json("/api/bootstrap")["products"]
            self.assertIn(result.product_id, [item["id"] for item in visible])

            # `events.MessageDeleted` shu funksiyani chaqiradi
            self.assertEqual(store.deactivate_by_msg(self.connection, msg_id), 1)

            after = _get_json("/api/bootstrap")["products"]
            self.assertNotIn(
                result.product_id,
                [item["id"] for item in after],
                "o'chirilgan post mahsuloti katalogda qolib ketdi",
            )
        finally:
            self.connection.execute("DELETE FROM products WHERE id = ?", (result.product_id,))
            self.connection.execute(
                "DELETE FROM parsed_posts WHERE chat_id = ? AND msg_id = ?", (CHAT_ID, str(msg_id))
            )
            self.connection.commit()


if __name__ == "__main__":
    unittest.main()
