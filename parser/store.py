"""SQLite bilan ishlash: mahsulotni yozish, takrorlanishni oldini olish, audit.

Baza — mavjud botning bazasi (`data/shop.db`). `products` jadvali sxemasi
o'zgartirilmaydi; parser o'zining `parsed_posts` jadvalini qo'shadi va u orqali
qaysi kanal posti qaysi mahsulotga aylanganini eslab qoladi (idempotent sync).
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence, Tuple

from .captions import ParsedCaption

# Bitta postda bir nechta mahsulot bo'lishi mumkin ("Şim - 149.900 söm / Vetrovka - ..."),
# shuning uchun kalit (chat_id, msg_id, item_index). `item_index = 0` — oddiy post.
SCHEMA = """
CREATE TABLE IF NOT EXISTS parsed_posts (
  chat_id    TEXT NOT NULL,
  msg_id     INTEGER NOT NULL,
  item_index INTEGER NOT NULL DEFAULT 0,
  product_id INTEGER,
  status     TEXT NOT NULL DEFAULT 'synced',   -- synced | skipped | error
  reason     TEXT,
  source_url TEXT,
  posted_at  TEXT,
  synced_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, msg_id, item_index)
);
CREATE INDEX IF NOT EXISTS idx_parsed_posts_product ON parsed_posts(product_id);
"""

# 1-versiya jadvali (item_index yo'q) — mavjud bazalarni buzmasdan ko'chirish uchun.
MIGRATE_V2 = """
DROP INDEX IF EXISTS idx_parsed_posts_product;
ALTER TABLE parsed_posts RENAME TO parsed_posts_v1;
CREATE TABLE parsed_posts (
  chat_id    TEXT NOT NULL,
  msg_id     INTEGER NOT NULL,
  item_index INTEGER NOT NULL DEFAULT 0,
  product_id INTEGER,
  status     TEXT NOT NULL DEFAULT 'synced',
  reason     TEXT,
  source_url TEXT,
  posted_at  TEXT,
  synced_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, msg_id, item_index)
);
INSERT INTO parsed_posts (chat_id, msg_id, item_index, product_id, status, reason, source_url, posted_at, synced_at)
  SELECT chat_id, msg_id, 0, product_id, status, reason, source_url, posted_at, synced_at FROM parsed_posts_v1;
DROP TABLE parsed_posts_v1;
CREATE INDEX IF NOT EXISTS idx_parsed_posts_product ON parsed_posts(product_id);
"""


@dataclass
class SaveResult:
    action: str  # created | updated | unchanged | skipped | error
    product_id: Optional[int] = None
    note: str = ""


def connect(db_path: Path) -> sqlite3.Connection:
    """Bazaga ulanish. Bot bir vaqtda ishlayotgani uchun WAL va timeout qo'yiladi."""
    connection = sqlite3.connect(str(db_path), timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executescript(SCHEMA)
    _migrate(connection)
    connection.commit()
    return connection


def _migrate(connection: sqlite3.Connection) -> None:
    """Eski `parsed_posts` jadvalini `item_index` bilan yangilaydi (ma'lumot saqlanadi)."""
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(parsed_posts)")}
    if "item_index" in columns:
        return
    connection.executescript(MIGRATE_V2)
    connection.commit()


def ensure_category(connection: sqlite3.Connection, slug: str, title: str, sort: int = 0) -> int:
    """Kategoriya bo'lmasa yaratadi (botdagi `ensureCategory` bilan bir xil mantiq)."""
    row = connection.execute("SELECT id FROM categories WHERE slug = ?", (slug,)).fetchone()
    if row:
        return int(row["id"])
    cursor = connection.execute(
        "INSERT INTO categories (slug, title, sort) VALUES (?, ?, ?)",
        (slug, title, sort),
    )
    connection.commit()
    return int(cursor.lastrowid)


def get_mapping(
    connection: sqlite3.Connection, chat_id: str, msg_id: int, item_index: int = 0
) -> Optional[sqlite3.Row]:
    return connection.execute(
        "SELECT * FROM parsed_posts WHERE chat_id = ? AND msg_id = ? AND item_index = ?",
        (str(chat_id), int(msg_id), int(item_index)),
    ).fetchone()


def get_product(connection: sqlite3.Connection, product_id: int) -> Optional[sqlite3.Row]:
    return connection.execute("SELECT * FROM products WHERE id = ?", (int(product_id),)).fetchone()


def _category_id_for(connection: sqlite3.Connection, slug: str, create: bool = True):
    """Kategoriya ID'sini qaytaradi; dry-run'da baza o'zgartirilmaydi."""
    row = connection.execute("SELECT id FROM categories WHERE slug = ?", (slug,)).fetchone()
    if row:
        return int(row["id"])
    if not create:
        return None
    return ensure_category(connection, slug, _category_title(slug))


def _product_values(
    connection: sqlite3.Connection,
    parsed: ParsedCaption,
    images: Sequence[str],
    category_slug: str,
    active: bool,
    fallback_title: str,
    create_category: bool = True,
) -> dict:
    category_id = _category_id_for(connection, category_slug, create=create_category)
    return {
        "title": (parsed.title or fallback_title)[:200],
        "description": parsed.description or "",
        "price": int(parsed.price or 0),
        "old_price": int(parsed.old_price) if parsed.old_price else None,
        "sizes": json.dumps(parsed.sizes, ensure_ascii=False),
        "images": json.dumps(list(images), ensure_ascii=False),
        "category_id": category_id,
        "badge": parsed.badge,
        "active": 1 if active else 0,
    }


def _category_title(slug: str) -> str:
    from .captions import CATEGORY_TITLES

    return CATEGORY_TITLES.get(slug, slug.replace("-", " ").title())


def record_skipped(
    connection: sqlite3.Connection,
    *,
    chat_id: str,
    msg_id: int,
    reason: str,
    source_url: str = "",
    posted_at: str = "",
    status: str = "skipped",
    item_index: int = 0,
) -> None:
    """Mahsulotga aylanmagan postni yozib qo'yadi (qayta urinib ko'rish uchun ko'rinadi)."""
    connection.execute(
        """INSERT INTO parsed_posts (chat_id, msg_id, item_index, product_id, status, reason, source_url, posted_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
           ON CONFLICT(chat_id, msg_id, item_index) DO UPDATE SET
             status = excluded.status,
             reason = excluded.reason,
             source_url = excluded.source_url,
             posted_at = excluded.posted_at,
             synced_at = datetime('now')""",
        (str(chat_id), int(msg_id), int(item_index), status, reason[:400], source_url, posted_at),
    )
    connection.commit()


def _same_values(current: sqlite3.Row, values: dict) -> bool:
    for key, value in values.items():
        existing = current[key]
        if key in {"sizes", "images"}:
            if json.loads(existing or "[]") != json.loads(value):
                return False
        elif key == "old_price":
            if (existing or None) != (value or None):
                return False
        elif key == "description":
            if (existing or "") != (value or ""):
                return False
        elif existing != value:
            return False
    return True


def save_product(
    connection: sqlite3.Connection,
    *,
    chat_id: str,
    msg_id: int,
    parsed: ParsedCaption,
    images: Sequence[str] = (),
    category_slug: str = "casual",
    source_url: str = "",
    posted_at: str = "",
    active: bool = True,
    update: bool = False,
    force: bool = False,
    dry_run: bool = False,
    item_index: int = 0,
) -> SaveResult:
    """Postni mahsulot sifatida saqlaydi yoki mavjudini yangilaydi.

    - `update=False`, `force=False`: avval sinxronlangan post qayta yozilmaydi.
    - `update=True`: matn/narx o'zgargan bo'lsa yangilanadi.
    - `force=True`: mavjud bo'lsa ham qayta yoziladi (media/narxni tuzatish uchun).
    """
    mapping = get_mapping(connection, chat_id, msg_id, item_index)
    existing_id = int(mapping["product_id"]) if mapping and mapping["product_id"] else None

    if mapping and mapping["status"] == "synced" and existing_id and not force:
        if not update:
            return SaveResult("unchanged", existing_id, "avval sinxronlangan")

    fallback_title = f"Mahsulot #{msg_id}" if not item_index else f"Mahsulot #{msg_id}/{item_index + 1}"
    values = _product_values(
        connection,
        parsed,
        images,
        category_slug,
        active,
        fallback_title,
        create_category=not dry_run,
    )

    if existing_id:
        current = get_product(connection, existing_id)
        if current is None:
            # Mahsulot qo'lda o'chirilgan — yangisini yaratamiz.
            existing_id = None
        else:
            if not values["images"] or values["images"] == "[]":
                # Faqat matn tahrirlangan bo'lsa rasmlar yo'qolmasin.
                values["images"] = current["images"]
            if _same_values(current, values) and not force:
                if not dry_run:
                    _touch_mapping(connection, chat_id, msg_id, existing_id, source_url, posted_at, item_index)
                return SaveResult("unchanged", existing_id, "o'zgarish yo'q")
            if dry_run:
                return SaveResult("updated", existing_id, "dry-run: yangilanadi")
            _update_product(connection, existing_id, values)
            _touch_mapping(connection, chat_id, msg_id, existing_id, source_url, posted_at, item_index)
            return SaveResult("updated", existing_id, "yangilandi")

    if dry_run:
        return SaveResult("created", None, "dry-run: yaratiladi")

    product_id = _insert_product(connection, values)
    _touch_mapping(connection, chat_id, msg_id, product_id, source_url, posted_at, item_index)
    return SaveResult("created", product_id, "qo'shildi")


def _insert_product(connection: sqlite3.Connection, values: dict) -> int:
    cursor = connection.execute(
        """INSERT INTO products (category_id, title, description, price, old_price, sizes, images, badge, active, sort)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)""",
        (
            values["category_id"],
            values["title"],
            values["description"],
            values["price"],
            values["old_price"],
            values["sizes"],
            values["images"],
            values["badge"],
            values["active"],
        ),
    )
    connection.commit()
    return int(cursor.lastrowid)


def _update_product(connection: sqlite3.Connection, product_id: int, values: dict) -> None:
    connection.execute(
        """UPDATE products SET category_id = ?, title = ?, description = ?, price = ?, old_price = ?,
                               sizes = ?, images = ?, badge = ?, active = ?
           WHERE id = ?""",
        (
            values["category_id"],
            values["title"],
            values["description"],
            values["price"],
            values["old_price"],
            values["sizes"],
            values["images"],
            values["badge"],
            values["active"],
            int(product_id),
        ),
    )
    connection.commit()


def _touch_mapping(
    connection: sqlite3.Connection,
    chat_id: str,
    msg_id: int,
    product_id: int,
    source_url: str,
    posted_at: str,
    item_index: int = 0,
) -> None:
    connection.execute(
        """INSERT INTO parsed_posts (chat_id, msg_id, item_index, product_id, status, reason, source_url, posted_at)
           VALUES (?, ?, ?, ?, 'synced', NULL, ?, ?)
           ON CONFLICT(chat_id, msg_id, item_index) DO UPDATE SET
             product_id = excluded.product_id,
             status = 'synced',
             reason = NULL,
             source_url = excluded.source_url,
             posted_at = excluded.posted_at,
             synced_at = datetime('now')""",
        (str(chat_id), int(msg_id), int(item_index), int(product_id), source_url, posted_at),
    )
    connection.commit()


def deactivate_extra_items(
    connection: sqlite3.Connection, chat_id: str, msg_id: int, keep_count: int
) -> int:
    """Post tahrirlanib mahsulot soni kamaygan bo'lsa, ortiqcha kartochkalar yashiriladi."""
    rows = connection.execute(
        "SELECT product_id FROM parsed_posts "
        "WHERE chat_id = ? AND msg_id = ? AND item_index >= ? AND status = 'synced'",
        (str(chat_id), int(msg_id), int(keep_count)),
    ).fetchall()
    count = 0
    for row in rows:
        if row["product_id"]:
            deactivate_product(connection, int(row["product_id"]))
            count += 1
    connection.execute(
        "DELETE FROM parsed_posts WHERE chat_id = ? AND msg_id = ? AND item_index >= ?",
        (str(chat_id), int(msg_id), int(keep_count)),
    )
    connection.commit()
    return count


def deactivate_product(connection: sqlite3.Connection, product_id: int) -> None:
    """Kanal posti o'chirilganda mahsulot katalogdan yashiriladi (baza tozalanmaydi)."""
    connection.execute("UPDATE products SET active = 0 WHERE id = ?", (int(product_id),))
    connection.commit()


def deactivate_by_msg(connection: sqlite3.Connection, msg_id: int, chat_id: Optional[str] = None) -> int:
    if chat_id:
        rows = connection.execute(
            "SELECT product_id FROM parsed_posts WHERE msg_id = ? AND chat_id = ?",
            (int(msg_id), str(chat_id)),
        ).fetchall()
    else:
        rows = connection.execute("SELECT product_id FROM parsed_posts WHERE msg_id = ?", (int(msg_id),)).fetchall()
    count = 0
    for row in rows:
        if row["product_id"]:
            deactivate_product(connection, int(row["product_id"]))
            count += 1
    return count


def deactivate_missing(connection: sqlite3.Connection, chat_id: str, keep_msg_ids: Sequence[int]) -> int:
    """`--prune`: kanalda endi ko'rinmayotgan postlarning mahsulotlarini yashiradi.

    Faqat sinxronlangan oyna ichidagi postlar tekshiriladi: `sync --limit 20` bilan
    ishga tushirilganda 21-postdan keyingi eski mahsulotlar o'chib ketmasligi kerak.
    """
    keep = {int(value) for value in keep_msg_ids}
    if not keep:
        return 0
    rows = connection.execute(
        "SELECT msg_id, product_id FROM parsed_posts "
        "WHERE chat_id = ? AND status = 'synced' AND CAST(msg_id AS INTEGER) >= ?",
        (str(chat_id), min(keep)),
    ).fetchall()
    count = 0
    for row in rows:
        if int(row["msg_id"]) in keep or not row["product_id"]:
            continue
        deactivate_product(connection, int(row["product_id"]))
        count += 1
    return count


def skipped_recent(connection: sqlite3.Connection, limit: int = 10) -> list:
    return [
        dict(row)
        for row in connection.execute(
            "SELECT msg_id, reason, posted_at FROM parsed_posts WHERE status != 'synced' ORDER BY synced_at DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
    ]


def counts(connection: sqlite3.Connection) -> dict:
    products = connection.execute("SELECT COUNT(*) AS c FROM products WHERE active = 1").fetchone()["c"]
    parsed = connection.execute("SELECT COUNT(*) AS c FROM parsed_posts WHERE status = 'synced'").fetchone()["c"]
    skipped = connection.execute("SELECT COUNT(*) AS c FROM parsed_posts WHERE status != 'synced'").fetchone()["c"]
    return {"products": products, "parsed": parsed, "skipped": skipped}
