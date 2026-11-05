"""`sync` oqimi testlari: albom birlashtirish va postni qayta ishlash.

Telegram talab qilinmaydi — xabarlar oddiy obyektlar bilan taqlid qilinadi,
`download_media=False` bo'lgani uchun klient ham chaqirilmaydi.
"""

from __future__ import annotations

import asyncio
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from parser import store
from parser.config import Settings
from parser.sync import Counters, build_source_url, group_posts, process_post

SCHEMA = """
CREATE TABLE categories (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  slug   TEXT UNIQUE NOT NULL,
  title  TEXT NOT NULL,
  sort   INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  description TEXT,
  price       INTEGER NOT NULL,
  old_price   INTEGER,
  sizes       TEXT NOT NULL DEFAULT '[]',
  images      TEXT NOT NULL DEFAULT '[]',
  badge       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


class FakeMessage:
    """Telethon `Message` ning faqat kerakli qismlari."""

    def __init__(self, msg_id, text="", grouped_id=None, chat_id=-1001234567890):
        self.id = msg_id
        self.message = text
        self.grouped_id = grouped_id
        self.chat_id = chat_id
        self.date = datetime(2026, 11, 1, 10, 0, tzinfo=timezone.utc)
        self.photo = None
        self.video = None
        self.file = None


class SyncFlowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db_path = Path(self.tmp.name) / "shop.db"
        connection = sqlite3.connect(str(db_path))
        connection.executescript(SCHEMA)
        connection.commit()
        connection.close()
        self.connection = store.connect(db_path)
        self.settings = Settings(require_price=True, publish_active=True, download_video=True)

    def tearDown(self):
        self.connection.close()
        self.tmp.cleanup()

    def test_album_messages_become_one_post(self):
        messages = [
            FakeMessage(102, "Kostyum «Atlas»\nNarx: 1 890 000 so'm", grouped_id=777),
            FakeMessage(101, "", grouped_id=777),
            FakeMessage(103, "O'lcham: M, L", grouped_id=777),
            FakeMessage(104, "Alohida post\nNarx: 500 000 so'm"),
        ]
        posts = group_posts(messages)
        self.assertEqual([post.msg_id for post in posts], [101, 104])
        album = posts[0]
        self.assertEqual(len(album.messages), 3)
        self.assertIn("Kostyum «Atlas»", album.text)
        self.assertIn("O'lcham: M, L", album.text)
        self.assertEqual(album.chat_id, "-1001234567890")

    def test_process_post_creates_product_once(self):
        post = group_posts([FakeMessage(201, "Klassik kostyum «Atlas»\nNarx: 1 890 000 so'm\nO'lcham: S, M, L")])[0]
        counters = Counters()

        async def run():
            return await process_post(
                client=None,
                settings=self.settings,
                connection=self.connection,
                post=post,
                collector=None,
                download_media=False,
                counters=counters,
            )

        first = asyncio.run(run())
        self.assertEqual(first.action, "created")
        self.assertEqual(counters.created, 1)

        row = store.get_product(self.connection, first.product_id)
        self.assertEqual(row["price"], 1890000)
        self.assertEqual(row["title"], "Klassik kostyum «Atlas»")

        second = asyncio.run(run())
        self.assertEqual(second.action, "unchanged")
        self.assertEqual(second.product_id, first.product_id)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) AS c FROM products").fetchone()["c"], 1)

    def test_post_without_price_is_skipped(self):
        post = group_posts([FakeMessage(202, "Yangi model haqida ma'lumot")])[0]
        counters = Counters()

        result = asyncio.run(
            process_post(
                client=None,
                settings=self.settings,
                connection=self.connection,
                post=post,
                collector=None,
                download_media=False,
                counters=counters,
            )
        )
        self.assertEqual(result.action, "skipped")
        self.assertEqual(counters.skipped, 1)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) AS c FROM products").fetchone()["c"], 0)
        recent = store.skipped_recent(self.connection)
        self.assertEqual(recent[0]["msg_id"], 202)
        self.assertEqual(recent[0]["reason"], "narx topilmadi")

    def test_multi_item_post_creates_several_products(self):
        # Kanaldagi haqiqiy format: bitta postda uchta mahsulot, "199.900 söm" narxlari.
        post = group_posts(
            [FakeMessage(301, "Vetrovka - 299.900 söm\nŞim - 149.900 söm\nOyoq kiyim - 199.900 söm")]
        )[0]
        counters = Counters()

        result = asyncio.run(
            process_post(
                client=None,
                settings=self.settings,
                connection=self.connection,
                post=post,
                collector=None,
                download_media=False,
                counters=counters,
            )
        )
        self.assertEqual(result.action, "created")
        self.assertEqual(counters.created, 3)
        rows = self.connection.execute("SELECT title, price FROM products ORDER BY id").fetchall()
        self.assertEqual([row["title"] for row in rows], ["Vetrovka", "Şim", "Oyoq kiyim"])
        self.assertEqual([row["price"] for row in rows], [299900, 149900, 199900])

        # Post o'chirilsa uchchala kartochka ham yashiriladi.
        self.assertEqual(store.deactivate_by_msg(self.connection, 301), 3)
        self.assertEqual(store.counts(self.connection)["products"], 0)

    def test_edit_with_fewer_items_hides_extra_cards(self):
        post = group_posts([FakeMessage(302, "Vetrovka - 299.900 söm\nŞim - 149.900 söm")])[0]
        args = dict(client=None, settings=self.settings, connection=self.connection, collector=None, download_media=False)
        asyncio.run(process_post(post=post, **args))
        self.assertEqual(self.connection.execute("SELECT COUNT(*) AS c FROM products").fetchone()["c"], 2)

        edited = group_posts([FakeMessage(302, "Vetrovka - 279.900 söm")])[0]
        asyncio.run(process_post(post=edited, **args))
        active = self.connection.execute("SELECT title, price FROM products WHERE active = 1").fetchall()
        self.assertEqual([(row["title"], row["price"]) for row in active], [("Vetrovka", 279900)])

    def test_source_url_variants(self):
        self.assertEqual(build_source_url("-1001234567890", 55), "https://t.me/c/1234567890/55")
        self.assertEqual(build_source_url("@standartuzbekistan", 55), "https://t.me/standartuzbekistan/55")


if __name__ == "__main__":
    unittest.main()
