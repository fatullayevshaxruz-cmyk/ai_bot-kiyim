# Kanal parseri — Standart Uzbekistan katalogi

Telegram kanaldagi postlarni (rasm/video + caption) o‘qib, mahsulot kartochkasini yaratadi va
botning bazasiga (`data/shop.db`) yozadi. Web App katalogi yangi mahsulotni **avtomatik** ko‘rsatadi —
qo‘lda admin panel orqali qo‘shish shart emas.

```
Telegram kanal (`CHANNEL` sozlamasi)
        │  Telethon (foydalanuvchi sessiyasi)
        ▼
  post / albom  ──►  caption tahlili: nom, narx, o‘lcham, kategoriya, tavsif
        │            media yuklab olish → data/uploads/tg-<chat>-<msg>-<n>.jpg|mp4
        ▼
  SQLite: products (+ parsed_posts audit)  ──►  Express /api/bootstrap  ──►  Web App katalog
```

## 1. Nega foydalanuvchi sessiyasi, bot tokeni emas?

Bot API kanal **tarixini** o‘qishga ruxsat bermaydi (`getChat` faqat kanal haqida ma’lumot beradi).
Shu sababli parser sizning Telegram akkauntingiz sessiyasi bilan ishlaydi va **kanalga a’zo**
(yoki admin) bo‘lishi kerak. Bot tokeni faqat do‘kon botining o‘ziga kerak.

## 2. O‘rnatish

```bash
python3 -m venv .venv && source .venv/bin/activate      # Python ≥ 3.9
pip install -r parser/requirements.txt
cp parser/.env.example parser/.env                      # qiymatlarni to‘ldiring
```

`api_id` / `api_hash`: [my.telegram.org](https://my.telegram.org) → *API development tools*.
Ularni **hech kimga bermang** va git’ga qo‘shmang (`parser/.env` `.gitignore` da).

```ini
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
CHANNEL=@kanal_username
```

## 3. Birinchi kirish

```bash
python -m parser login
```

Telefon raqami, Telegram kodi (va bo‘lsa 2FA paroli) so‘raladi. Shundan keyin
`parser/data/standart.session` yaratiladi — bu **akkaunt kaliti**, uni ham saqlang.

## 4. Ishlatish

```bash
# 1) avval sinab ko‘rish — bazaga hech narsa yozilmaydi
python -m parser sync --limit 20 --dry-run

# 2) oxirgi 200 postni sinxronlash (media bilan)
python -m parser sync

# 3) real vaqtda kuzatish: yangi post → yangi mahsulot, o‘chirilgani → yo‘qoladi
python -m parser watch

# 4) API kalit va sessiyasiz: ochiq kanal veb-ko‘rinishidan (t.me/s/<username>)
python -m parser web --limit 20 --dry-run
python -m parser web --limit 20
```

`web` rejimi kanal **ochiq** (username’i bor) bo‘lsa ishlaydi: post matni, JPG rasmlar va
MP4 videolar `t.me/s/...` sahifasidan olinadi. Bot admin bo‘lishi ham, foydalanuvchi
sessiyasi ham shart emas. Cheklov: real-time kuzatuv yo‘q — yangi postlarni olish uchun
buyruqni qayta ishga tushiring (cron/systemd timer), va media havolalari tokenli bo‘lgani
uchun fayllar import paytida darhol yuklab olinadi.

Manba kanal `parser/.env` dagi `CHANNEL` da turadi (hozir `-1002067707525`).
Bot o‘sha kanalga admin bo‘lishi **shart emas** — parser sizning akkauntingiz
sessiyasi bilan o‘qiydi, akkaunt esa kanalga a’zo bo‘lishi kifoya.

| Buyruq / flag | Vazifasi |
| --- | --- |
| `sync --limit N` | oxirgi N postni o‘qish (default `HISTORY_LIMIT=200`) |
| `sync --no-media` | faqat matn/narx (rasm yuklanmaydi) |
| `sync --no-update` | mavjud mahsulotlarni yangilamaslik |
| `sync --force` | avval sinxronlangan postlarni qayta yozish |
| `sync --prune` | kanalda yo‘q postlarning mahsulotini yashirish |
| `sync --dry-run` | hech narsa yozilmaydi, faqat hisobot |
| `web --limit N` | ochiq kanal veb-ko‘rinishidan N post import (kalit/sessiya kerak emas) |
| `web --channel @nom` | boshqa ochiq kanalni import qilish |
| `test-parse "matn"` | caption tahlilini Telegram’siz sinash |

`watch` kanalni tinglaydi: yangi post, albom, tahrir va o‘chirishni ham ushlaydi
(o‘chirilgan post mahsuloti katalogdan **yashiriladi**, bazadan o‘chirilmaydi).
Ishga tushishida u avval tarixni bir marta tekshiradi (`--no-initial-sync` bilan o‘chirsa
bo‘ladi) — shuning uchun bot o‘chib turgan paytda qo‘shilgan postlar ham katalogga tushadi,
o‘chirilganlari esa yashiriladi.

`sync --prune` faqat **o‘qilgan oyna ichidagi** postlarni tekshiradi: `--limit 20` bilan
tekshirganda 21-postdan keyingi mahsulotlar o‘chib ketmaydi. Qo‘lda tekshirish uchun:

```bash
python -m parser sync --prune --limit 200 --dry-run
```

Doimiy ishlashi uchun systemd:

```ini
[Unit]
Description=Standart Uzbekistan shop kanal parseri
After=network.target

[Service]
WorkingDirectory=/opt/standart-shop
ExecStart=/opt/standart-shop/.venv/bin/python -m parser watch
Restart=always
EnvironmentFile=/opt/standart-shop/parser/.env

[Install]
WantedBy=multi-user.target
```

## 5. Caption qanday tahlil qilinadi

| Maydon | Qoida |
| --- | --- |
| `price` | `1 890 000 so'm`, `1.890.000`, `199.900 söm`, `1890000`, `1,5 mln so'm`, `$45` (kurs: `PRICE_USD_RATE`) |
| `old_price` | `Eski narx: …` / `old price` / `2 190 000 → 1 890 000` + chegirma belgisi |
| `sizes` | `O'lcham: S-XL` (oraliq ochiladi), `2XL`, `Razmer: 46-52`, `S, M, L` |
| `category` | hashtag (`#kostyum`, `#poyabzal`) → kalit so‘zlar (`krossovka`, `ko'ylak`…) → `DEFAULT_CATEGORY` |
| `title` | `Kardigan - 199.900 söm` qatoridan nom; bunday qator bo‘lmasa — eng “mahsulotga o‘xshash” qator (kategoriya so‘zi, «qo‘shtirnoq», katta harflar) |
| `badge` | `Chegirma` (`-20%`, `aksiya`), `Yangi` (`yangi`, `new`) |
| `description` | nom, narx, o‘lcham va hashtag qatorlarisiz qolgan matn |

Narx topilmasa post **katalogga chiqmaydi** (`REQUIRE_PRICE=true`) va `parsed_posts` jadvalida
`status='skipped'` bo‘lib qoladi — `sync` oxirida sababi ko‘rsatiladi.

**Bitta post — bir nechta mahsulot.** Kanal postlarida ko‘pincha bir nechta qator bor:

```
Vetrovka - 299.900 söm
Şim - 149.900 söm
Oyoq kiyim - 199.900 söm
```

Bunday postdan **uchta alohida kartochka** yaratiladi, media (rasm/video) ularga umumiy bo‘ladi.
«Narx:», «Chegirma narx:» kabi yorliq qatorlar mahsulot deb olinmaydi. Post tahrirlanib
qatorlar kamaysa, ortiqcha kartochkalar yashiriladi.

## 6. Baza

`products` jadvali bot bilan bir xil (parser uning sxemasini o‘zgartirmaydi). Qo‘shimcha
`parsed_posts` jadvali qaysi post qaysi mahsulotga aylanganini saqlaydi:

| ustun | ma’nosi |
| --- | --- |
| `chat_id`, `msg_id`, `item_index` | manba post va undagi mahsulot tartibi (asosiy kalit — takror yozilmaydi) |
| `product_id` | bog‘langan mahsulot |
| `status` | `synced` / `skipped` / `error` |
| `reason` | o‘tkazib yuborilgan sababi |
| `source_url`, `posted_at`, `synced_at` | audit |

Shu tufayli `sync` ni qayta-qayta ishga tushirish dublikat yaratmaydi: post o‘zgarmagan bo‘lsa
`unchanged`, tahrirlangan bo‘lsa `updated` bo‘ladi. Media fayllari nomi ham deterministik
(`tg-<chat>-<msg>-<n>.<ext>`) — qayta yuklanmaydi.

Eski bazada `item_index` ustuni bo‘lmasa, parser uni **avtomatik ko‘chiradi** (ma’lumot yo‘qolmaydi).

## 7. Web App

Parser `data/uploads` ga yozadi, Express esa uni `/uploads/...` sifatida beradi — shuning uchun
qo‘shimcha sozlash kerak emas. Rasm galereyasi va video (`mp4/mov/webm`) mahsulot oynasida
ko‘rinadi; kartochka va savatchada video o‘rniga poster ishlatiladi.

Admin panelida mahsulot ochilganda ham kanal postidagi kabi barcha rasm/video bitta albom
bo‘lib ketadi (`src/bot/media.js`): 10 tadan ko‘p media bir necha albomga bo‘linadi, matn esa
birinchi albom ostida chiqadi. `PUBLIC_URL` bo‘lmasa bot lokal faylni o‘zi yuklaydi, media
umuman yuborilmasa — matnli kartochka bilan qaytadi.

## 8. Instagram haqida

Instagram hozircha **kiritilmagan**: sahifani ochish uchun login/cookie yoki rasmiy Graph API
(business akkaunt + token) kerak, scraping esa Instagram qoidalarini buzadi va tez buziladi.
Kerak bo‘lsa, eng toza yo‘l — Instagram Graph API dan postlarni olib, xuddi shu `store.save_product`
funksiyasiga uzatish (30 qatorli adapter). Shu sababli `store` va `captions` modullari
Telegram’dan mustaqil yozilgan.

## 9. Muammolar

| Belgi | Yechim |
| --- | --- |
| `Yetishmayapti: TELEGRAM_API_ID…` | `parser/.env` to‘ldirilmagan |
| `The authorization key…` / sessiya xatosi | `python -m parser login` ni qayta bajaring (yoki `parser/data/*.session` ni o‘chirib) |
| `Cannot find any entity` | `CHANNEL` xato yoki akkaunt kanalga a’zo emas |
| `Media yuklanmadi: … too large` | `MAX_FILE_MB` ni oshiring yoki `DOWNLOAD_VIDEO=false` |
| Narxlar noto‘g‘ri chiqadi | `python -m parser test-parse "<post matni>"` bilan tekshirib, `captions.py` dagi qoidalarni moslashtiring |
| Mahsulot katalogda ko‘rinmaydi | `PUBLISH_ACTIVE=false` yoki `active=0`; `--prune` noto‘g‘ri ishlatilgan bo‘lishi mumkin |

## 10. Testlar

```bash
PYTHONPATH=. python3 -m unittest discover -s parser/tests -t .
```

- `test_captions.py` — narx/o‘lcham/nom/kategoriya qoidalari (Telegram’siz).
- `test_store.py` — vaqtinchalik bazada idempotentlik, yangilash, `--prune`, audit.
- `test_catalog_api.py` — parser yozgan mahsulot `/api/bootstrap` da ko‘rinishini tekshiradi
  (server ishlamasa avtomatik `skip`), oxirida o‘z yozuvini o‘chiradi.
