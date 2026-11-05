"""Standart Uzbekistan kanal parseri.

Kanal postlarini (rasm/video + caption) o'qib, mahsulot kartochkasini yaratadi va
botning SQLite bazasiga yozadi — Web App katalogi yangi mahsulotni darhol ko'rsatadi.

Asosiy modullar:
  captions.py — matndan nom, narx, o'lcham, kategoriya ajratish (Telegram'siz)
  store.py    — SQLite: products/parsed_posts, idempotent saqlash
  media.py    — rasm/video yuklab olish (data/uploads)
  sync.py     — tarixni sinxronlash va real-time kuzatuv
  __main__.py — CLI (login / sync / watch / test-parse)
"""

from __future__ import annotations

__all__ = ["captions", "store", "media", "sync", "config"]
