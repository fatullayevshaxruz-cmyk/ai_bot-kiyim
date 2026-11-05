"""`python -m parser web` — ochiq kanal veb-ko'rinishidan import qilish testlari.

Tarmoq ishlatilmaydi: HTML namunalari test ichida yasaladi.
"""

from __future__ import annotations

import unittest

from parser.webpreview import WebPost, clean_text, parse_posts


def message_block(msg_id: int, text_html: str, *, photo: bool = False, video: bool = False) -> str:
    parts = [
        f'<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" '
        f'data-post="standartuzbekistan/{msg_id}">',
        f'<time datetime="2026-11-03T15:0{msg_id % 10}:00+00:00"></time>',
    ]
    if photo:
        parts.append(
            '<a class="tgme_widget_message_photo_wrap blured js-message_photo" '
            'style="width:100%;background-image:url(\'https://cdn4.telesco.pe/file/photo'
            f'{msg_id}.jpg\')"></a>'
        )
    if video:
        parts.append(
            '<video src="https://cdn4.telesco.pe/file/video'
            f'{msg_id}.mp4?token=abc" class="tgme_widget_message_video js-message_video"></video>'
        )
        parts.append(
            '<video src="https://cdn4.telesco.pe/file/video'
            f'{msg_id}.mp4?token=abc" class="tgme_widget_message_video blured"></video>'
        )
    if text_html:
        parts.append(f'<div class="tgme_widget_message_text js-message_text" dir="auto">{text_html}</div>')
    parts.append("</div></div>")
    return "".join(parts)


class ParsePostsTest(unittest.TestCase):
    def test_matn_teglar_va_entitylar_tozalanadi(self) -> None:
        self.assertEqual(
            clean_text("<b>Kardigan</b><br/>199.900 söm &amp; chegirma&#33;<br/><br/>"),
            "Kardigan\n199.900 söm & chegirma!",
        )

    def test_postlar_raqami_matn_rasm_va_video(self) -> None:
        page = (
            '<div class="tgme_widget_message_wrap">'
            + message_block(9601, "Kardigan - 199.900 söm", photo=True)
            + message_block(9602, "Vetrovka - 299.900 söm", video=True)
            + "</div>"
        )

        posts = parse_posts(page, "@standartuzbekistan")

        self.assertEqual([post.msg_id for post in posts], [9601, 9602])
        self.assertIn("199.900", posts[0].text)
        self.assertEqual(posts[0].photos, ["https://cdn4.telesco.pe/file/photo9601.jpg"])
        self.assertEqual(posts[0].chat_id, "@standartuzbekistan")
        self.assertEqual(posts[0].source_url, "https://t.me/standartuzbekistan/9601")
        # Video ikki marta (blured + oddiy) uchraydi, lekin bitta havola qoladi.
        self.assertEqual(posts[1].videos, ["https://cdn4.telesco.pe/file/video9602.mp4?token=abc"])
        self.assertEqual(posts[1].photos, [])

    def test_post_bolmasa_bosh_royxat(self) -> None:
        self.assertEqual(parse_posts("<html><body>Kanal yopiq</body></html>", "kanal"), [])

    def test_webpost_source_url(self) -> None:
        post = WebPost(chat_id="@kanal", msg_id=42)
        self.assertEqual(post.source_url, "https://t.me/kanal/42")


if __name__ == "__main__":
    unittest.main()
