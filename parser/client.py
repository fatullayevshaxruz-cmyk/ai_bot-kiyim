"""Telethon klientini yaratish (kredensiallar tekshiriladi)."""

from __future__ import annotations

from .config import ConfigError, Settings


def build_client(settings: Settings):
    """Foydalanuvchi sessiyasi bilan Telethon klientini qaytaradi.

    Bot tokeni emas, **foydalanuvchi** sessiyasi kerak: Bot API kanal tarixini
    o'qishga ruxsat bermaydi.
    """
    settings.require_credentials()
    try:
        from telethon import TelegramClient
    except ImportError as exc:  # pragma: no cover - o'rnatish bo'yicha yo'riqnoma
        raise ConfigError(
            "Telethon o'rnatilmagan. `pip install -r parser/requirements.txt` buyrug'ini bajaring."
        ) from exc

    settings.prepare_dirs()
    return TelegramClient(str(settings.session_path), settings.api_id, settings.api_hash)
