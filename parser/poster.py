"""Videodan bitta kadr (poster) olish.

Kartochkalarda faqat rasm ko'rinishi kerak, shuning uchun video yuklanganda undan
poster kadr ham olinadi. `ffmpeg` bo'lsa u ishlatiladi, macOS'da esa `qlmanage`.
Poster fayli deterministik (`<video-stem>-poster.jpg|png`) — qayta ishlashda
mavjud bo'lsa yana yaratilmaydi.
"""

from __future__ import annotations

import json
import logging
import shutil
import sqlite3
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

VIDEO_SUFFIXES = (".mp4", ".mov", ".webm", ".m4v")


def is_video(src: object) -> bool:
    """`/uploads/x.mp4` kabi havola video ekanini aniqlaydi."""
    value = str(src or "").lower().split("?", 1)[0]
    return value.endswith(VIDEO_SUFFIXES)


def _ok(path: Path) -> bool:
    return path.exists() and path.stat().st_size > 0


def extract_poster(video_path: Path, stem: Path, max_width: int = 900) -> Optional[Path]:
    """`<stem>.jpg` yoki `<stem>.png` poster yaratadi; imkoni bo'lmasa None."""
    video_path = Path(video_path)
    stem = Path(stem)
    if not _ok(video_path):
        return None
    for suffix in (".jpg", ".png"):
        existing = stem.with_suffix(suffix)
        if _ok(existing):
            return existing

    if shutil.which("ffmpeg"):
        target = stem.with_suffix(".jpg")
        for seek in ("1", "0"):
            try:
                subprocess.run(
                    [
                        "ffmpeg", "-y", "-loglevel", "error",
                        "-ss", seek, "-i", str(video_path),
                        "-frames:v", "1",
                        "-vf", f"scale='min({max_width},iw)':-2",
                        "-q:v", "3",
                        str(target),
                    ],
                    check=True,
                    timeout=180,
                    capture_output=True,
                )
            except (subprocess.SubprocessError, OSError) as exc:
                logger.debug("ffmpeg poster xatosi: %s", exc)
                continue
            if _ok(target):
                return target

    if shutil.which("qlmanage"):
        with tempfile.TemporaryDirectory() as tmp:
            try:
                subprocess.run(
                    ["qlmanage", "-t", "-s", str(max_width), "-o", tmp, str(video_path)],
                    check=False,
                    timeout=180,
                    capture_output=True,
                )
            except (subprocess.SubprocessError, OSError) as exc:
                logger.warning("qlmanage poster xatosi: %s", exc)
                return None
            produced = sorted(Path(tmp).glob(f"{video_path.name}*"))
            if produced:
                target = stem.with_suffix(".png")
                shutil.move(str(produced[0]), target)
                if _ok(target):
                    return target

    logger.warning("poster olinmadi: %s", video_path.name)
    return None


def backfill_posters(settings, connection: sqlite3.Connection, *, dry_run: bool = False) -> int:
    """Bazadagi barcha videolarga poster qo'shadi (rasm ro'yxatining boshiga)."""
    rows = connection.execute("SELECT id, images FROM products").fetchall()
    updated = 0
    for row in rows:
        try:
            media = json.loads(row["images"] or "[]")
        except ValueError:
            continue
        if not isinstance(media, list) or not any(is_video(item) for item in media):
            continue

        result = []
        changed = False
        for src in media:
            if is_video(src):
                name = Path(str(src)).name
                poster = extract_poster(
                    settings.uploads_dir / name,
                    settings.uploads_dir / f"{Path(name).stem}-poster",
                )
                if poster:
                    url = f"{settings.media_prefix}/{poster.name}"
                    if url not in result:
                        result.append(url)
                    if url not in media:
                        changed = True
            if src not in result:
                result.append(src)

        if changed and not dry_run:
            connection.execute(
                "UPDATE products SET images = ? WHERE id = ?",
                (json.dumps(result, ensure_ascii=False), row["id"]),
            )
            updated += 1

    if updated:
        connection.commit()
    return updated
