"""Telegram media fayllarini `data/uploads` ga yuklab olish.

Fayl nomlari deterministik (`tg-<chat>-<msg>-<index>.<ext>`), shuning uchun
qayta ishga tushirishda mavjud fayl qayta yuklanmaydi va bir xil URL qaytadi.
Web App bu fayllarni `/uploads/...` orqali ko'radi (bot bilan bir papka).
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import List, Optional

from .config import Settings

logger = logging.getLogger(__name__)

_SAFE_RE = re.compile(r"[^a-zA-Z0-9_-]+")
_EXT_RE = re.compile(r"^\.[a-z0-9]{2,5}$")


def _safe(value: object) -> str:
    return _SAFE_RE.sub("_", str(value)).strip("_") or "x"


def _extension(message: object, fallback: str) -> str:
    file_info = getattr(message, "file", None)
    ext = getattr(file_info, "ext", None) or ""
    ext = ext.lower()
    if _EXT_RE.match(ext):
        return ext
    mime = getattr(file_info, "mime_type", "") or ""
    mapping = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "video/mp4": ".mp4",
        "video/quicktime": ".mov",
    }
    return mapping.get(mime, fallback)


class MediaCollector:
    """Postdagi rasm/videolarni yuklaydi va `/uploads/...` havolalarini qaytaradi."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.settings.uploads_dir.mkdir(parents=True, exist_ok=True)

    async def collect(self, client, messages) -> List[str]:
        urls: List[str] = []
        for message in messages:
            try:
                urls.extend(await self._collect_one(client, message, len(urls)))
            except Exception as exc:  # bitta fayl xatosi butun postni to'xtatmaydi
                logger.warning("media #%s yuklanmadi: %s", getattr(message, "id", "?"), exc)
        return urls

    async def _collect_one(self, client, message, index: int) -> List[str]:
        is_photo = bool(getattr(message, "photo", None))
        is_video = bool(getattr(message, "video", None))
        if not is_photo and not is_video:
            return []

        size_mb = 0.0
        file_info = getattr(message, "file", None)
        if file_info is not None and getattr(file_info, "size", None):
            size_mb = float(file_info.size) / (1024 * 1024)
        if size_mb > self.settings.max_file_mb:
            logger.warning(
                "media #%s juda katta (%.1f MB > %s MB) — o'tkazib yuborildi",
                message.id,
                size_mb,
                self.settings.max_file_mb,
            )
            return []

        chat_id = getattr(message, "chat_id", 0) or 0
        basename = f"tg-{_safe(chat_id)}-{int(message.id)}-{index}"

        if is_photo:
            ext = _extension(message, ".jpg")
            return [await self._download(client, message, basename + ext)]

        if not self.settings.download_video:
            # Faqat video bo'lsa va yuklash o'chirilgan bo'lsa — muqova rasmini olamiz.
            poster = await self._download_thumb(client, message, basename + "-poster.jpg")
            return [poster] if poster else []

        urls: List[str] = []
        poster = await self._download_thumb(client, message, basename + "-poster.jpg")
        if poster:
            urls.append(poster)
        ext = _extension(message, ".mp4")
        urls.append(await self._download(client, message, basename + ext))
        return urls

    async def _download(self, client, message, filename: str) -> str:
        path = self.settings.uploads_dir / filename
        if not path.exists() or path.stat().st_size == 0:
            await client.download_media(message, file=str(path))
        return f"{self.settings.media_prefix}/{filename}"

    async def _download_thumb(self, client, message, filename: str) -> Optional[str]:
        thumbs = getattr(getattr(message, "document", None), "thumbs", None) or []
        path: Path = self.settings.uploads_dir / filename
        if path.exists() and path.stat().st_size:
            return f"{self.settings.media_prefix}/{filename}"
        if not thumbs:
            return None
        try:
            await client.download_media(message, file=str(path), thumb=-1)
        except Exception as exc:
            logger.warning("poster #%s olinmadi: %s", getattr(message, "id", "?"), exc)
            return None
        if path.exists() and path.stat().st_size:
            return f"{self.settings.media_prefix}/{filename}"
        return None
