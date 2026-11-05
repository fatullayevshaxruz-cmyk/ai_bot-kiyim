"""Kanal postlarini mahsulotga aylantirish: tarixni sinxronlash va real-time kuzatish.

Telethon foydalanuvchi sessiyasi orqali ishlaydi, chunki botlar kanal tarixini
o'qiy olmaydi (Bot API bunday metod bermaydi).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable, List, Optional

from . import store
from .captions import parse_items
from .config import Settings
from .media import MediaCollector

logger = logging.getLogger(__name__)


@dataclass
class Post:
    """Bitta post (albom bo'lsa — bitta post, bir nechta media)."""

    chat_id: str
    msg_id: int
    text: str = ""
    posted_at: str = ""
    grouped_id: Optional[int] = None
    messages: List[object] = field(default_factory=list)

    @property
    def source_url(self) -> str:
        return build_source_url(self.chat_id, self.msg_id)


@dataclass
class Counters:
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    skipped: int = 0
    errors: int = 0
    deactivated: int = 0

    def summary(self) -> str:
        return (
            f"yangi: {self.created} · yangilandi: {self.updated} · o'zgarishsiz: {self.unchanged} · "
            f"o'tkazib yuborildi: {self.skipped} · xato: {self.errors} · yashirildi: {self.deactivated}"
        )


def build_source_url(chat_id: str, msg_id: int) -> str:
    """Postga to'g'ridan-to'g'ri havola (admin tekshirishi uchun)."""
    raw = str(chat_id).strip()
    if raw.startswith("@"):
        return f"https://t.me/{raw.lstrip('@')}/{msg_id}"
    inner = raw
    if inner.startswith("-100"):
        inner = inner[4:]
    elif inner.startswith("-"):
        inner = inner[1:]
    return f"https://t.me/c/{inner}/{msg_id}"


def _post_date(message) -> str:
    date = getattr(message, "date", None)
    if isinstance(date, datetime):
        return date.astimezone(timezone.utc).isoformat(timespec="seconds")
    return ""


def build_post(messages: Iterable[object]) -> Optional[Post]:
    items = [message for message in messages if message is not None and getattr(message, "id", None)]
    if not items:
        return None
    items.sort(key=lambda message: message.id)

    texts: List[str] = []
    for message in items:
        text = (getattr(message, "message", None) or "").strip()
        if text and text not in texts:
            texts.append(text)

    return Post(
        chat_id=str(getattr(items[0], "chat_id", "") or ""),
        msg_id=int(items[0].id),
        text="\n".join(texts),
        posted_at=_post_date(items[0]),
        grouped_id=getattr(items[0], "grouped_id", None),
        messages=items,
    )


def group_posts(messages: Iterable[object]) -> List[Post]:
    """Albom xabarlarini bitta postga birlashtiradi (Telegram ularni alohida yuboradi)."""
    albums = {}
    singles: List[List[object]] = []
    for message in messages:
        if message is None or not getattr(message, "id", None):
            continue
        grouped_id = getattr(message, "grouped_id", None)
        if grouped_id:
            albums.setdefault(grouped_id, []).append(message)
        else:
            singles.append([message])

    posts = []
    for group in singles + list(albums.values()):
        post = build_post(group)
        if post:
            posts.append(post)
    posts.sort(key=lambda post: post.msg_id)
    return posts


async def process_post(
    client,
    settings: Settings,
    connection,
    post: Post,
    collector: MediaCollector,
    *,
    update: bool = True,
    force: bool = False,
    dry_run: bool = False,
    download_media: bool = True,
    counters: Optional[Counters] = None,
) -> store.SaveResult:
    """Bitta postni tahlil qilib bazaga yozadi. Xato bo'lsa butun sync to'xtamaydi.

    Bitta postda bir nechta mahsulot bo'lishi mumkin ("Şim - 149.900 söm" kabi
    qatorlar) — ularning har biri alohida kartochka bo'ladi va media ularga
    umumiy bo'ladi.
    """
    counters = counters or Counters()
    try:
        items = parse_items(post.text, settings.usd_rate, settings.default_category)
        priced = [item for item in items if item.price] if settings.require_price else items

        if settings.require_price and not priced:
            logger.info("#%s: narx topilmadi — o'tkazib yuborildi", post.msg_id)
            if not dry_run:
                store.record_skipped(
                    connection,
                    chat_id=post.chat_id,
                    msg_id=post.msg_id,
                    reason="narx topilmadi",
                    source_url=post.source_url,
                    posted_at=post.posted_at,
                )
            counters.skipped += 1
            return store.SaveResult("skipped", None, "narx topilmadi")

        images = await collector.collect(client, post.messages) if download_media else []
        if settings.require_media and not images:
            if not dry_run:
                store.record_skipped(
                    connection,
                    chat_id=post.chat_id,
                    msg_id=post.msg_id,
                    reason="media topilmadi",
                    source_url=post.source_url,
                    posted_at=post.posted_at,
                )
            counters.skipped += 1
            return store.SaveResult("skipped", None, "media topilmadi")

        primary: Optional[store.SaveResult] = None
        for index, parsed in enumerate(items):
            if settings.require_price and not parsed.price:
                # Narxsiz qator (masalan orasida sarlavha) — kartochka yaratilmaydi.
                continue
            result = store.save_product(
                connection,
                chat_id=post.chat_id,
                msg_id=post.msg_id,
                parsed=parsed,
                images=images,
                category_slug=parsed.category_slug or settings.default_category,
                source_url=post.source_url,
                posted_at=post.posted_at,
                active=settings.publish_active,
                update=update,
                force=force,
                dry_run=dry_run,
                item_index=index,
            )
            if primary is None:
                primary = result

            if result.action == "created":
                counters.created += 1
            elif result.action == "updated":
                counters.updated += 1
            else:
                counters.unchanged += 1

            logger.info(
                "#%s%s → %s%s | %s | %s so'm | %s",
                post.msg_id,
                f"/{index + 1}" if len(items) > 1 else "",
                result.action,
                f" (id {result.product_id})" if result.product_id else "",
                parsed.title or "—",
                parsed.price if parsed.price else "—",
                ", ".join(parsed.sizes) or "o'lchamsiz",
            )

        if not dry_run:
            # Post tahrirlanib qatorlar kamaygan bo'lsa, ortiqcha kartochkalar yashiriladi.
            # (bir mahsulotli postda ham chaqiriladi: ilgari 3 ta bo'lib, hozir 1 ta bo'lishi mumkin)
            hidden = store.deactivate_extra_items(connection, post.chat_id, post.msg_id, len(items))
            if hidden:
                logger.info("#%s: %s ortiqcha kartochka yashirildi", post.msg_id, hidden)

        return primary or store.SaveResult("skipped", None, "mahsulot topilmadi")
    except Exception as exc:
        logger.exception("#%s: xato — %s", post.msg_id, exc)
        counters.errors += 1
        if not dry_run:
            store.record_skipped(
                connection,
                chat_id=post.chat_id,
                msg_id=post.msg_id,
                reason=f"xato: {exc}",
                source_url=post.source_url,
                posted_at=post.posted_at,
                status="error",
            )
        return store.SaveResult("error", None, str(exc))


async def sync_history(
    client,
    settings: Settings,
    connection,
    *,
    limit: Optional[int] = None,
    update: bool = True,
    force: bool = False,
    dry_run: bool = False,
    download_media: bool = True,
    prune: bool = False,
) -> Counters:
    """Kanal tarixini oxiridan boshlab o'qiydi va mahsulotlarni yangilaydi."""
    limit = limit or settings.history_limit
    messages = await client.get_messages(settings.channel, limit=limit)
    posts = group_posts(messages)
    logger.info("%s: %s xabar → %s post", settings.channel, len(messages or []), len(posts))

    counters = Counters()
    collector = MediaCollector(settings)
    for post in posts:
        await process_post(
            client,
            settings,
            connection,
            post,
            collector,
            update=update,
            force=force,
            dry_run=dry_run,
            download_media=download_media,
            counters=counters,
        )

    if prune and posts and not dry_run:
        counters.deactivated = store.deactivate_missing(
            connection, posts[0].chat_id, [post.msg_id for post in posts]
        )
        logger.info("prune: %s mahsulot yashirildi", counters.deactivated)

    return counters


async def watch(client, settings: Settings, connection) -> None:
    """Kanalga yangi post tushganda avtomatik qo'shadi (real-time)."""
    from telethon import events  # faqat shu rejimda kerak

    collector = MediaCollector(settings)
    lock = asyncio.Lock()

    async def handle(messages, label: str) -> None:
        async with lock:
            for post in group_posts(messages):
                result = await process_post(
                    client,
                    settings,
                    connection,
                    post,
                    collector,
                    update=True,
                    force=False,
                    download_media=True,
                )
                suffix = f" → mahsulot #{result.product_id}" if result.product_id else ""
                logger.info("[%s] post #%s: %s%s", label, post.msg_id, result.action, suffix)

    @client.on(events.NewMessage(chats=settings.channel))
    async def on_new(event):  # noqa: ANN001
        message = event.message
        if getattr(message, "grouped_id", None):
            return  # albom `events.Album` da to'liq ishlanadi
        await handle([message], "yangi")

    @client.on(events.Album(chats=settings.channel))
    async def on_album(event):  # noqa: ANN001
        await handle(list(event.messages), "albom")

    @client.on(events.MessageEdited(chats=settings.channel))
    async def on_edit(event):  # noqa: ANN001
        message = event.message
        if getattr(message, "grouped_id", None):
            return
        await handle([message], "tahrir")

    @client.on(events.MessageDeleted(chats=settings.channel))
    async def on_delete(event):  # noqa: ANN001
        async with lock:
            for msg_id in event.deleted_ids:
                hidden = store.deactivate_by_msg(connection, msg_id)
                if hidden:
                    logger.info("[o'chirilgan] post #%s → %s mahsulot yashirildi", msg_id, hidden)

    logger.info("Kuzatuv boshlandi: %s (Ctrl+C bilan to'xtatiladi)", settings.channel)
    await client.run_until_disconnected()
