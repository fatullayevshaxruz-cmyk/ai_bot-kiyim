"""Ochiq kanalning veb-ko'rinishidan (t.me/s/<kanal>) mahsulotlarni sinxronlash.

Telegram API kalitlari, foydalanuvchi sessiyasi yoki bot admin huquqi kerak emas:
kanal **ochiq** bo'lsa, `t.me/s/<username>` sahifasida oxirgi postlar, rasmlar (jpg)
va videolar (mp4) hammaga ko'rinadi. Sahifa `?before=<msg_id>` bilan orqaga varaqlanadi.

Cheklovlar (Telethon rejimiga nisbatan):
  * faqat ochiq (username'i bor) kanal ishlaydi;
  * media havolalari `cdn*.telesco.pe` tokenli — shuning uchun fayllar darhol yuklab olinadi;
  * real-time kuzatuv yo'q — yangi postlarni `web` buyrug'ini qayta ishga tushirib olasiz.

Postni mahsulotga aylantirish mantiqi `captions.py` va `store.py` da — ular ikkala
rejimda ham bir xil, shu sababli narx/o'lcham qoidalari takrorlanmaydi.
"""

from __future__ import annotations

import html as html_lib
import logging
import re
import sqlite3
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

from . import store
from .captions import parse_items
from .config import Settings
from .poster import extract_poster
from .sync import Counters, build_source_url

logger = logging.getLogger(__name__)

BASE_URL = "https://t.me/s/"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"
)

_POST_RE = re.compile(r'data-post="([^"/]+)/(\d+)"')
_TIME_RE = re.compile(r'<time[^>]*datetime="([^"]+)"')
_TEXT_RE = re.compile(r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', re.S)
_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")
_VIDEO_RE = re.compile(r'<video[^>]*\bsrc="([^"]+)"', re.IGNORECASE)
_STYLE_URL_RE = re.compile(r"background-image:url\('([^']+)'\)")
_EXT_RE = re.compile(r"\.[a-z0-9]{2,5}$", re.IGNORECASE)


@dataclass
class WebPost:
    """Veb-ko'rinishdan o'qilgan bitta post."""

    chat_id: str
    msg_id: int
    text: str = ""
    posted_at: str = ""
    photos: List[str] = field(default_factory=list)
    videos: List[str] = field(default_factory=list)

    @property
    def source_url(self) -> str:
        return build_source_url(self.chat_id, self.msg_id)


def _dedupe(values: List[str]) -> List[str]:
    seen = set()
    result = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def clean_text(markup: str) -> str:
    """Caption HTML'ini oddiy matnga aylantiradi (<br> → qator, teglar olib tashlanadi)."""
    text = _BR_RE.sub("\n", markup)
    text = _TAG_RE.sub("", text)
    text = html_lib.unescape(text)
    return "\n".join(line.strip() for line in text.splitlines() if line.strip())


def _photo_urls(chunk: str) -> List[str]:
    urls: List[str] = []
    for match in re.finditer(r"tgme_widget_message_photo_wrap", chunk):
        window = chunk[match.start() : match.start() + 800]
        found = _STYLE_URL_RE.search(window)
        if found:
            urls.append(found.group(1))
    return _dedupe(urls)


def parse_posts(page: str, channel: str) -> List[WebPost]:
    """HTML sahifadan postlarni ajratadi (msg_id, matn, rasm va video havolalari)."""
    channel = channel.lstrip("@")
    matches = list(_POST_RE.finditer(page))
    posts: List[WebPost] = []
    seen_ids = set()

    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(page)
        chunk = page[match.start() : end]
        msg_id = int(match.group(2))
        if msg_id in seen_ids:
            continue
        seen_ids.add(msg_id)

        text_match = _TEXT_RE.search(chunk)
        time_match = _TIME_RE.search(chunk)
        posts.append(
            WebPost(
                chat_id=f"@{channel}",
                msg_id=msg_id,
                text=clean_text(text_match.group(1)) if text_match else "",
                posted_at=time_match.group(1) if time_match else "",
                photos=_photo_urls(chunk),
                videos=_dedupe(_VIDEO_RE.findall(chunk)),
            )
        )

    posts.sort(key=lambda post: post.msg_id)
    return posts


def fetch_page(channel: str, before: Optional[int] = None, timeout: int = 25, attempts: int = 3) -> str:
    url = f"{BASE_URL}{channel.lstrip('@')}"
    if before:
        url += f"?before={int(before)}"
    last_error: Optional[Exception] = None
    for attempt in range(attempts):
        request = urllib.request.Request(
            url,
            headers={"User-Agent": USER_AGENT, "Accept-Language": "uz,ru;q=0.8,en;q=0.6"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read().decode("utf-8", "replace")
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as exc:
            # t.me ba'zan ulanishni uzadi — qayta urinish odatda yetarli.
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Sahifa ochilmadi ({url}): {last_error}")


def collect_posts(channel: str, limit: int, max_pages: int = 20) -> List[WebPost]:
    """Ochiq sahifani orqaga varaqlab, oxirgi `limit` postni yig'adi."""
    collected: List[WebPost] = []
    seen = set()
    before: Optional[int] = None

    for _ in range(max_pages):
        page = fetch_page(channel, before)
        batch = parse_posts(page, channel)
        fresh = [post for post in batch if post.msg_id not in seen]
        if not fresh:
            break
        for post in fresh:
            seen.add(post.msg_id)
            collected.append(post)
        if len(collected) >= limit:
            break
        before = min(post.msg_id for post in batch)

    collected.sort(key=lambda post: post.msg_id)
    return collected[-limit:] if limit else collected


def _download(url: str, path: Path, max_mb: int) -> bool:
    if path.exists() and path.stat().st_size > 0:
        return True
    limit = max_mb * 1024 * 1024
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Referer": "https://t.me/"})
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            declared = int(response.headers.get("Content-Length") or 0)
            if declared and declared > limit:
                logger.warning("media %.1f MB > %s MB — o'tkazib yuborildi", declared / 1048576, max_mb)
                return False
            data = response.read(limit + 1)
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        logger.warning("media yuklanmadi (%s): %s", path.name, exc)
        return False
    if len(data) > limit:
        logger.warning("media %s MB dan katta — o'tkazib yuborildi", max_mb)
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".part")
    temp.write_bytes(data)
    temp.replace(path)
    return True


def _extension(url: str, fallback: str) -> str:
    clean = url.split("?", 1)[0]
    found = _EXT_RE.search(clean)
    return found.group(0).lower() if found else fallback


def download_media(settings: Settings, post: WebPost, channel: str) -> List[str]:
    """Postdagi rasm va videolarni `data/uploads` ga yuklaydi, `/uploads/...` qaytaradi."""
    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    safe_channel = re.sub(r"[^a-zA-Z0-9_-]+", "_", channel.lstrip("@")) or "channel"
    urls: List[str] = []
    index = 0

    for photo in post.photos:
        index += 1
        name = f"web-{safe_channel}-{post.msg_id}-{index}{_extension(photo, '.jpg')}"
        if _download(photo, settings.uploads_dir / name, settings.max_file_mb):
            urls.append(f"{settings.media_prefix}/{name}")

    for video in post.videos:
        if not settings.download_video:
            break
        index += 1
        name = f"web-{safe_channel}-{post.msg_id}-{index}{_extension(video, '.mp4')}"
        if _download(video, settings.uploads_dir / name, settings.max_file_mb):
            # Kartochkalarda faqat rasm ko'rinadi — videodan poster kadr ham olinadi.
            poster = extract_poster(settings.uploads_dir / name, settings.uploads_dir / f"{Path(name).stem}-poster")
            if poster:
                urls.append(f"{settings.media_prefix}/{poster.name}")
            urls.append(f"{settings.media_prefix}/{name}")

    return urls


def import_posts(
    settings: Settings,
    connection: sqlite3.Connection,
    *,
    limit: int = 20,
    dry_run: bool = False,
    download: bool = True,
    channel: Optional[str] = None,
) -> Counters:
    """Veb-ko'rinishdagi postlarni katalogga yozadi. `sync` bilan bir xil hisoblagichlar."""
    channel = (channel or settings.web_channel).lstrip("@")
    posts = collect_posts(channel, limit)
    logger.info("%s: %s post topildi", channel, len(posts))
    counters = Counters()

    for post in posts:
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
                continue

            images = [] if (dry_run or not download) else download_media(settings, post, channel)
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
                continue

            for index, parsed in enumerate(items):
                if settings.require_price and not parsed.price:
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
                    update=True,
                    dry_run=dry_run,
                    item_index=index,
                )
                if result.action == "created":
                    counters.created += 1
                elif result.action == "updated":
                    counters.updated += 1
                elif result.action == "unchanged":
                    counters.unchanged += 1
                logger.info(
                    "#%s%s → %s | %s | %s so'm | media %s",
                    post.msg_id,
                    f"/{index + 1}" if len(items) > 1 else "",
                    result.action,
                    parsed.title or "—",
                    parsed.price if parsed.price else "—",
                    len(images),
                )

            if not dry_run:
                store.deactivate_extra_items(connection, post.chat_id, post.msg_id, len(items))
        except Exception as exc:  # bitta post butun importni to'xtatmaydi
            logger.exception("#%s: xato — %s", post.msg_id, exc)
            counters.errors += 1

    return counters
