"""Parser sozlamalari.

Qiymatlar `parser/.env` faylidan o'qiladi (mavjud muhit o'zgaruvchilarini
almashtirmasdan), shuning uchun tizim birligi (systemd) bilan ham ishlaydi.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent


def load_env(path: Path) -> None:
    """Oddiy `.env` o'quvchi (tashqi kutubxonasiz, izoh va qo'shtirnoqlarni tushunadi)."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_env(BASE_DIR / ".env")


def _text(name: str, fallback: str = "") -> str:
    return str(os.environ.get(name, fallback) or fallback).strip()


def _int(name: str, fallback: int) -> int:
    try:
        return int(float(_text(name, str(fallback))))
    except (TypeError, ValueError):
        return fallback


def _path(name: str, fallback: Path) -> Path:
    """Nisbiy yo'llar parser papkasiga nisbatan o'qiladi.

    `.env` da `SHOP_DB=../data/shop.db` deb yozilgan — bu parser papkasidan
    hisoblanganda `standart-shop/data/shop.db` bo'ladi. Ish papkasi (cwd) esa
    boshqa joyda bo'lishi mumkin, shuning uchun cwd ga tayanmaymiz.
    """
    value = _text(name)
    if not value:
        return fallback
    path = Path(value).expanduser()
    return path if path.is_absolute() else (BASE_DIR / path).resolve()


def _bool(name: str, fallback: bool = False) -> bool:
    value = _text(name, "1" if fallback else "").lower()
    if not value:
        return fallback
    return value in {"1", "true", "yes", "on", "ha"}


class ConfigError(RuntimeError):
    """Majburiy sozlama yetishmayapti."""


@dataclass
class Settings:
    # --- Telegram (foydalanuvchi sessiyasi) ---
    api_id: int = field(default_factory=lambda: _int("TELEGRAM_API_ID", 0))
    api_hash: str = field(default_factory=lambda: _text("TELEGRAM_API_HASH"))
    session: str = field(default_factory=lambda: _text("TELEGRAM_SESSION", "standart"))
    channel: str = field(default_factory=lambda: _text("CHANNEL", "@standartuzbekistan"))
    # Ochiq kanal username'i — `web` rejimi uchun (API kalit/sessiya kerak emas).
    web_channel: str = field(default_factory=lambda: _text("CHANNEL_USERNAME", "standartuzbekistan"))

    # --- Ma'lumotlar bazasi va media ---
    db_path: Path = field(default_factory=lambda: _path("SHOP_DB", PROJECT_DIR / "data" / "shop.db"))
    uploads_dir: Path = field(
        default_factory=lambda: _path("SHOP_UPLOADS", PROJECT_DIR / "data" / "uploads")
    )
    media_prefix: str = "/uploads"

    # --- Tahlil qoidalari ---
    usd_rate: int = field(default_factory=lambda: _int("PRICE_USD_RATE", 12700))
    default_category: str = field(default_factory=lambda: _text("DEFAULT_CATEGORY", "casual"))
    require_price: bool = field(default_factory=lambda: _bool("REQUIRE_PRICE", True))
    require_media: bool = field(default_factory=lambda: _bool("REQUIRE_MEDIA", False))
    publish_active: bool = field(default_factory=lambda: _bool("PUBLISH_ACTIVE", True))
    download_video: bool = field(default_factory=lambda: _bool("DOWNLOAD_VIDEO", True))
    max_file_mb: int = field(default_factory=lambda: _int("MAX_FILE_MB", 48))
    history_limit: int = field(default_factory=lambda: _int("HISTORY_LIMIT", 200))

    @property
    def session_path(self) -> Path:
        """Telethon sessiya fayli (maxfiy — git'ga tushmasin)."""
        return BASE_DIR / "data" / self.session

    def require_credentials(self) -> None:
        missing = []
        if not self.api_id:
            missing.append("TELEGRAM_API_ID")
        if not self.api_hash:
            missing.append("TELEGRAM_API_HASH")
        if missing:
            raise ConfigError(
                "Yetishmayapti: "
                + ", ".join(missing)
                + ". https://my.telegram.org → API development tools dan oling va parser/.env ga yozing."
            )

    def prepare_dirs(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.uploads_dir.mkdir(parents=True, exist_ok=True)
        self.session_path.parent.mkdir(parents=True, exist_ok=True)


settings = Settings()
