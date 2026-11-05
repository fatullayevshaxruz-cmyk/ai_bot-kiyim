"""`config` testlari: yo'llar va majburiy kredensiallar."""

from __future__ import annotations

import os
import unittest
from pathlib import Path
from unittest import mock

from parser.config import BASE_DIR, PROJECT_DIR, ConfigError, Settings


class ConfigTest(unittest.TestCase):
    def tearDown(self):
        for key in ("SHOP_DB", "SHOP_UPLOADS", "TELEGRAM_API_ID", "TELEGRAM_API_HASH", "CHANNEL"):
            os.environ.pop(key, None)

    def test_relative_paths_are_resolved_from_parser_dir(self):
        # `.env` dagi qiymatlar (masalan `../data/shop.db`) ish papkasiga bog'liq bo'lmasin
        os.environ["SHOP_DB"] = "../data/shop.db"
        os.environ["SHOP_UPLOADS"] = "../data/uploads"
        settings = Settings()
        self.assertEqual(settings.db_path, (BASE_DIR / "../data/shop.db").resolve())
        self.assertEqual(settings.db_path, PROJECT_DIR / "data" / "shop.db")
        self.assertEqual(settings.uploads_dir, PROJECT_DIR / "data" / "uploads")

    def test_defaults_without_env_point_to_bot_database(self):
        settings = Settings()
        self.assertEqual(settings.db_path, PROJECT_DIR / "data" / "shop.db")
        self.assertTrue(settings.require_price)
        self.assertTrue(settings.download_video)

    def test_missing_credentials_raise_config_error(self):
        os.environ["TELEGRAM_API_ID"] = ""
        os.environ["TELEGRAM_API_HASH"] = ""
        with self.assertRaises(ConfigError):
            Settings().require_credentials()

    def test_channel_id_is_read_as_is(self):
        os.environ["CHANNEL"] = "-1002067707525"
        self.assertEqual(Settings().channel, "-1002067707525")

    def test_bundled_env_example_is_valid(self):
        """Namuna `.env` ni ko'chirib ishlatsa ham baza yo'li to'g'ri bo'lishi kerak."""
        example = (BASE_DIR / ".env.example").read_text(encoding="utf-8").replace("[TEMPLATE]\n", "")
        values = dict(
            line.split("=", 1)
            for line in example.splitlines()
            if "=" in line and not line.strip().startswith("#")
        )
        cleaned = {key: value.split("#")[0].strip() for key, value in values.items()}
        with mock.patch.dict(os.environ, cleaned):
            settings = Settings()
            self.assertEqual(settings.db_path, PROJECT_DIR / "data" / "shop.db")
            self.assertTrue(Path(settings.uploads_dir).is_absolute())
            self.assertTrue(settings.api_id)


if __name__ == "__main__":
    unittest.main()
