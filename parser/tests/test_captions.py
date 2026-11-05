"""Caption tahlili testlari (Telegram va bazaga bog'liq emas).

Ishga tushirish:
    cd standart-shop && python3 -m unittest discover -s parser/tests -t .
"""

from __future__ import annotations

import unittest

from parser.captions import parse_badge, parse_caption, parse_items, parse_price, parse_sizes

TYPICAL_POST = """
🔥 Yangi kolleksiya

Klassik kostyum «Atlas»

Narx: 1 890 000 so'm
O'lchamlar: S, M, L, XL

Yetkazib berish butun O'zbekiston bo'ylab.
"""


class CaptionTest(unittest.TestCase):
    def test_typical_post(self):
        parsed = parse_caption(TYPICAL_POST)
        self.assertEqual(parsed.title, "Klassik kostyum «Atlas»")
        self.assertEqual(parsed.price, 1890000)
        self.assertIsNone(parsed.old_price)
        self.assertEqual(parsed.sizes, ["S", "M", "L", "XL"])
        self.assertEqual(parsed.category_slug, "kostyumlar")
        self.assertEqual(parsed.badge, "Yangi")
        self.assertNotIn("Narx:", parsed.description)
        self.assertNotIn("O'lchamlar:", parsed.description)

    def test_price_formats(self):
        cases = {
            "Narx: 1.890.000 so'm": 1890000,
            "Narxi: 1 890 000 so‘m": 1890000,
            "1890000": 1890000,
            "1,5 mln so'm": 1500000,
            "Narx: 2 500 000 so'm": 2500000,
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                price, old, _currency = parse_price(text)
                self.assertEqual(price, expected)
                self.assertIsNone(old)

    def test_price_in_usd_is_converted(self):
        price, _old, _currency = parse_price("Narx: $45", usd_rate=12700)
        self.assertEqual(price, 45 * 12700)

    def test_phone_is_not_a_price(self):
        price, _old, _currency = parse_price("Buyurtma uchun: +998 90 123 45 67")
        self.assertIsNone(price)
        self.assertEqual(parse_sizes("Telefon: +998 90 123 45 67"), [])

    def test_old_price_variants(self):
        price, old, _currency = parse_price("Eski narx: 2 190 000 so'm\nYangi narx: 1 890 000 so'm")
        self.assertEqual(price, 1890000)
        self.assertEqual(old, 2190000)

        price, old, _currency = parse_price("Aksiya! 2 190 000 so'm → 1 890 000 so'm")
        self.assertEqual(price, 1890000)
        self.assertEqual(old, 2190000)

    def test_size_ranges_and_aliases(self):
        self.assertEqual(parse_sizes("O'lcham: S-XL"), ["S", "M", "L", "XL"])
        self.assertEqual(parse_sizes("Razmer: 46-52"), ["46", "48", "50", "52"])
        self.assertEqual(parse_sizes("Mavjud o‘lchamlar: 2XL, 3XL"), ["XXL", "3XL"])
        self.assertEqual(parse_sizes("O'lchamlar: XL, L, M, S"), ["S", "M", "L", "XL"])

    def test_sizes_ignore_prices(self):
        self.assertEqual(parse_sizes("Narx: 1 890 000 so'm"), [])

    def test_category_detection(self):
        self.assertEqual(parse_caption("#poyabzal Krossovka Nike Air").category_slug, "poyabzallar")
        self.assertEqual(parse_caption("Erkaklar uchun yozgi ko'ylak").category_slug, "koylaklar")
        self.assertEqual(parse_caption("Teri kamar, charm").category_slug, "aksessuarlar")
        self.assertEqual(parse_caption("Hech qanday kalit so'z yo'q", default_category="casual").category_slug, "casual")

    def test_title_fallbacks(self):
        self.assertIsNone(parse_caption("#kostyum #yangi").title)
        self.assertIsNone(parse_caption("Narx: 1 890 000 so'm").title)

    def test_badges(self):
        self.assertEqual(parse_badge("Chegirma -20%"), "Chegirma")
        self.assertEqual(parse_badge("Yangi model keldi"), "Yangi")
        self.assertIsNone(parse_badge("Klassik kostyum «Atlas»"))

    def test_description_skips_price_and_size_lines(self):
        parsed = parse_caption(
            "Kostyum «Atlas»\nNarx: 2 000 000 so'm\nChegirma narx: 1 800 000 so'm\nO'lcham: M"
        )
        self.assertEqual(parsed.description, "")

    def test_no_price(self):
        parsed = parse_caption("Yangi model haqida ma'lumot")
        self.assertIsNone(parsed.price)

    def test_real_channel_formats(self):
        # Kanalda narx "199.900 söm" ko'rinishida yoziladi (nuqta — minglik ajratgich).
        parsed = parse_caption("Kardigan - 199.900 söm")
        self.assertEqual(parsed.title, "Kardigan")
        self.assertEqual(parsed.price, 199900)

        parsed = parse_caption("Çemodan (katta) — 299.900 söm")
        self.assertEqual(parsed.title, "Çemodan (katta)")
        self.assertEqual(parsed.price, 299900)

    def test_phone_and_footer_are_not_description(self):
        parsed = parse_caption(
            "Kurtka - 349.900 söm\n📞 Telefon:\n+998 91 413 03 33\n📍Dökonlarımız manzillari\nstandartmanzillari"
        )
        self.assertEqual(parsed.title, "Kurtka")
        self.assertEqual(parsed.price, 349900)
        self.assertEqual(parsed.description, "")

    def test_multi_item_post_is_split(self):
        items = parse_items("Vetrovka - 299.900 söm\nŞim - 149.900 söm\nOyoq kiyim - 199.900 söm")
        self.assertEqual([item.title for item in items], ["Vetrovka", "Şim", "Oyoq kiyim"])
        self.assertEqual([item.price for item in items], [299900, 149900, 199900])
        self.assertEqual(items[2].category_slug, "poyabzallar")

    def test_price_labels_are_not_products(self):
        items = parse_items("Kostyum «Atlas»\nNarx: 2 000 000 so'm\nChegirma narx: 1 800 000 so'm")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].title, "Kostyum «Atlas»")
        self.assertEqual(items[0].price, 1800000)

    def test_hashtags(self):
        parsed = parse_caption("#kostyum Narx: 1 000 000 so'm #yangi")
        self.assertEqual(parsed.hashtags, ["kostyum", "yangi"])


if __name__ == "__main__":
    unittest.main()
