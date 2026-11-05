"""CLI: `python -m parser <buyruq>`.

Buyruqlar:
  login       — foydalanuvchi sessiyasini yaratish (bir marta, interfaol)
  sync        — kanal tarixini o'qib, mahsulotlarni bazaga yozish (Telethon)
  web         — ochiq kanal veb-ko'rinishidan import (API kalit va sessiya kerak emas)
  posters     — mavjud videolardan poster kadr yaratib, mahsulot rasmlariga qo'shish
  watch       — kanalni real vaqtda kuzatish (yangi post → mahsulot, o'chirilgani → yashiriladi)
  test-parse  — matnni kalitlarsiz tahlil qilish (Telegram'siz)
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from . import store
from .captions import human_summary, parse_items
from .client import build_client
from .config import ConfigError, settings
from .poster import backfill_posters
from .sync import Counters, sync_history, watch
from .webpreview import import_posts

logger = logging.getLogger("parser")


def _setup_logging(verbose: bool = False) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("telethon").setLevel(logging.WARNING)


async def cmd_login() -> int:
    client = build_client(settings)
    print(f"Sessiya fayli: {settings.session_path}")
    print("Telefon raqami va Telegram kodi so'raladi. Kod ikki bosqichli parol bo'lsa — parol ham.")
    await client.start()
    me = await client.get_me()
    username = f"@{me.username}" if getattr(me, "username", None) else me.first_name
    print(f"✅ Kirildi: {username} (id {me.id})")
    await client.disconnect()
    return 0


async def cmd_sync(args: argparse.Namespace) -> int:
    client = build_client(settings)
    connection = store.connect(settings.db_path)
    try:
        await client.start()
        counters: Counters = await sync_history(
            client,
            settings,
            connection,
            limit=args.limit,
            update=not args.no_update,
            force=args.force,
            dry_run=args.dry_run,
            download_media=not args.no_media,
            prune=args.prune,
        )
        print("\nSinxronlash tugadi:", counters.summary())
        if args.dry_run:
            print("(dry-run: bazaga hech narsa yozilmadi)")
        stats = store.counts(connection)
        print(f"Bazada: {stats['products']} faol mahsulot, {stats['parsed']} sinxron post, {stats['skipped']} o'tkazilgan")
        for row in store.skipped_recent(connection, 5):
            print(f"  · post #{row['msg_id']}: {row['reason']}")
        return 0
    finally:
        connection.close()
        await client.disconnect()


async def cmd_watch(args: argparse.Namespace) -> int:
    client = build_client(settings)
    connection = store.connect(settings.db_path)
    try:
        await client.start()
        # Ishga tushishda tarixni bir marta tekshiramiz: bot o'chib turgan paytda
        # qo'shilgan postlar ham katalogga tushadi, o'chirilganlari esa yashiriladi.
        if not args.no_initial_sync:
            counters = await sync_history(
                client,
                settings,
                connection,
                limit=args.limit,
                update=True,
                prune=True,
            )
            stats = store.counts(connection)
            print("Boshlang‘ich sinxronlash:", counters.summary())
            print(f"Bazada: {stats['products']} faol mahsulot")
        await watch(client, settings, connection)
        return 0
    finally:
        connection.close()


def cmd_web(args: argparse.Namespace) -> int:
    connection = store.connect(settings.db_path)
    try:
        counters = import_posts(
            settings,
            connection,
            limit=args.limit,
            dry_run=args.dry_run,
            download=not args.no_media,
            channel=args.channel,
        )
        print("\nVeb-import tugadi:", counters.summary())
        if args.dry_run:
            print("(dry-run: bazaga hech narsa yozilmadi)")
        stats = store.counts(connection)
        print(f"Bazada: {stats['products']} faol mahsulot, {stats['parsed']} sinxron post, {stats['skipped']} o'tkazilgan")
        for row in store.skipped_recent(connection, 5):
            print(f"  · post #{row['msg_id']}: {row['reason']}")
        return 0
    finally:
        connection.close()


def cmd_posters(args: argparse.Namespace) -> int:
    connection = store.connect(settings.db_path)
    try:
        count = backfill_posters(settings, connection, dry_run=args.dry_run)
        label = "dry-run: yangilanadi" if args.dry_run else "yangilandi"
        print(f"Poster: {count} mahsulot {label}")
        return 0
    finally:
        connection.close()


def cmd_test_parse(args: argparse.Namespace) -> int:
    text = args.text if args.text else sys.stdin.read()
    if not text.strip():
        print("Matn bo'sh. Misol: python -m parser test-parse \"Narx: 1 890 000 so'm\"")
        return 2
    items = parse_items(text, settings.usd_rate, settings.default_category)
    if len(items) > 1:
        print(f"Bitta postda {len(items)} ta mahsulot topildi:\n")
    for index, parsed in enumerate(items, 1):
        if len(items) > 1:
            print(f"[{index}]")
        print(human_summary(parsed))
        if parsed.hashtags:
            print(f"Hashtaglar: {', '.join('#' + tag for tag in parsed.hashtags)}")
        if index < len(items):
            print()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m parser",
        description="Telegram kanal postlarini do'kon katalogiga sinxronlaydi",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="batafsil log")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("login", help="Telegram sessiyasini yaratish")

    sync_parser = sub.add_parser("sync", help="kanal tarixini sinxronlash")
    sync_parser.add_argument("--limit", type=int, default=None, help=f"oxirgi N post (default {settings.history_limit})")
    sync_parser.add_argument("--no-update", action="store_true", help="mavjud mahsulotlarni yangilamaslik")
    sync_parser.add_argument("--force", action="store_true", help="avval sinxronlangan postlarni qayta yozish")
    sync_parser.add_argument("--dry-run", action="store_true", help="bazaga yozmasdan sinab ko'rish")
    sync_parser.add_argument("--no-media", action="store_true", help="media yuklamaslik")
    sync_parser.add_argument("--prune", action="store_true", help="kanalda yo'q postlarni katalogdan yashirish")

    web_parser = sub.add_parser("web", help="ochiq kanal veb-ko'rinishidan sinxronlash (API kalitsiz)")
    web_parser.add_argument("--limit", type=int, default=20, help="oxirgi N post (default 20)")
    web_parser.add_argument("--channel", default=None, help="kanal username'i (default CHANNEL_USERNAME)")
    web_parser.add_argument("--dry-run", action="store_true", help="bazaga yozmasdan sinab ko'rish")
    web_parser.add_argument("--no-media", action="store_true", help="rasm/video yuklamaslik")

    posters_parser = sub.add_parser("posters", help="videolardan poster kadr yaratish")
    posters_parser.add_argument("--dry-run", action="store_true", help="bazaga yozmasdan sinash")

    watch_parser = sub.add_parser("watch", help="kanalni real vaqtda kuzatish")
    watch_parser.add_argument("--limit", type=int, default=None, help=f"boshlang'ich tekshiruvda N post (default {settings.history_limit})")
    watch_parser.add_argument(
        "--no-initial-sync",
        action="store_true",
        help="ishga tushishda tarixni tekshirmaslik (faqat yangi postlarni kutish)",
    )

    parse_parser = sub.add_parser("test-parse", help="caption tahlilini kalitlarsiz sinash")
    parse_parser.add_argument("text", nargs="?", help="post matni (bo'sh bo'lsa stdin o'qiladi)")

    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    _setup_logging(args.verbose)

    try:
        if args.command == "login":
            return asyncio.run(cmd_login())
        if args.command == "sync":
            return asyncio.run(cmd_sync(args))
        if args.command == "watch":
            return asyncio.run(cmd_watch(args))
        if args.command == "web":
            return cmd_web(args)
        if args.command == "posters":
            return cmd_posters(args)
        if args.command == "test-parse":
            return cmd_test_parse(args)
    except ConfigError as exc:
        print(f"❌ {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\nTo'xtatildi.", file=sys.stderr)
        return 130
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
