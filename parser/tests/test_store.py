"""`store` moduli testlari — vaqtinchalik bazada (haqiqiy shop.db ga tegmaydi)."""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from parser import store
from parser.captions import ParsedCaption

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


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "shop.db"
        connection = sqlite3.connect(str(self.db_path))
        connection.executescript(SCHEMA)
        connection.commit()
        connection.close()
        self.connection = store.connect(self.db_path)

    def tearDown(self):
        self.connection.close()
        self.tmp.cleanup()

    def _parsed(self, **overrides) -> ParsedCaption:
        values = {
            "title": "Test kostyum «Atlas»",
            "price": 1890000,
            "sizes": ["M", "L"],
            "description": "Tavsif matni",
            "category_slug": "kostyumlar",
            "badge": "Yangi",
        }
        values.update(overrides)
        return ParsedCaption(**values)

    def _save(self, **overrides):
        params = {
            "chat_id": "-1001",
            "msg_id": 10,
            "parsed": self._parsed(),
            "images": ["/uploads/a.jpg"],
            "category_slug": "kostyumlar",
            "source_url": "https://t.me/c/1001/10",
            "posted_at": "2026-11-01T10:00:00+00:00",
        }
        params.update(overrides)
        return store.save_product(self.connection, **params)

    def test_create_then_unchanged(self):
        first = self._save()
        self.assertEqual(first.action, "created")
        self.assertIsNotNone(first.product_id)

        row = store.get_product(self.connection, first.product_id)
        self.assertEqual(row["price"], 1890000)
        self.assertEqual(json.loads(row["sizes"]), ["M", "L"])
        self.assertEqual(json.loads(row["images"]), ["/uploads/a.jpg"])
        self.assertEqual(row["badge"], "Yangi")
        category = self.connection.execute(
            "SELECT slug, title FROM categories WHERE id = ?", (row["category_id"],)
        ).fetchone()
        self.assertEqual(category["slug"], "kostyumlar")
        self.assertEqual(category["title"], "Kostyumlar")

        second = self._save()
        self.assertEqual(second.action, "unchanged")
        self.assertEqual(second.product_id, first.product_id)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) AS c FROM products").fetchone()["c"], 1)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) AS c FROM categories").fetchone()["c"], 1)

    def test_update_price_keeps_images_when_missing(self):
        created = self._save()
        updated = self._save(parsed=self._parsed(price=1690000), images=[], update=True)
        self.assertEqual(updated.action, "updated")
        row = store.get_product(self.connection, created.product_id)
        self.assertEqual(row["price"], 1690000)
        self.assertEqual(json.loads(row["images"]), ["/uploads/a.jpg"])

    def test_force_rewrites_and_new_caption_applies(self):
        self._save()
        result = self._save(parsed=self._parsed(title="Yangi nom", price=1000000), force=True)
        self.assertEqual(result.action, "updated")
        self.assertEqual(store.get_product(self.connection, result.product_id)["title"], "Yangi nom")

    def test_dry_run_writes_nothing(self):
        result = self._save(dry_run=True)
        self.assertEqual(result.action, "created")
        self.assertIsNone(result.product_id)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) AS c FROM products").fetchone()["c"], 0)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) AS c FROM categories").fetchone()["c"], 0)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) AS c FROM parsed_posts").fetchone()["c"], 0)

    def test_skipped_audit(self):
        store.record_skipped(self.connection, chat_id="-1001", msg_id=11, reason="narx topilmadi")
        stats = store.counts(self.connection)
        self.assertEqual(stats["skipped"], 1)
        recent = store.skipped_recent(self.connection)
        self.assertEqual(recent[0]["msg_id"], 11)
        self.assertEqual(recent[0]["reason"], "narx topilmadi")

    def test_deactivate_by_msg(self):
        created = self._save()
        hidden = store.deactivate_by_msg(self.connection, 10)
        self.assertEqual(hidden, 1)
        self.assertEqual(store.get_product(self.connection, created.product_id)["active"], 0)
        self.assertEqual(store.counts(self.connection)["products"], 0)

    def test_deactivate_missing_prune(self):
        self._save(msg_id=10)
        self._save(msg_id=20, parsed=self._parsed(title="Ikkinchi"))
        # `sync --limit` bilan faqat bir qism tarix o'qiladi: oynadan tashqaridagi
        # eski postlarga tegilmasligi kerak, aks holda butun katalog o'chib ketardi.
        hidden = store.deactivate_missing(self.connection, "-1001", keep_msg_ids=[20])
        self.assertEqual(hidden, 0)
        self.assertEqual(store.counts(self.connection)["products"], 2)

    def test_prune_hides_only_vanished_posts_inside_window(self):
        self._save(msg_id=10)
        middle = self._save(msg_id=20, parsed=self._parsed(title="Kanalda o‘chirilgan"))
        last = self._save(msg_id=30, parsed=self._parsed(title="Oxirgi post"))
        hidden = store.deactivate_missing(self.connection, "-1001", keep_msg_ids=[10, 30])
        self.assertEqual(hidden, 1)
        self.assertEqual(store.get_product(self.connection, middle.product_id)["active"], 0)
        self.assertEqual(store.get_product(self.connection, last.product_id)["active"], 1)
        self.assertEqual(store.counts(self.connection)["products"], 2)

    def test_different_messages_share_category(self):
        self._save(msg_id=10)
        self._save(msg_id=20, parsed=self._parsed(title="Boshqa mahsulot"))
        self.assertEqual(self.connection.execute("SELECT COUNT(*) AS c FROM categories").fetchone()["c"], 1)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) AS c FROM products").fetchone()["c"], 2)


if __name__ == "__main__":
    unittest.main()
