# ONE23 — Telegram Mini App do‘kon boti

ONE23 brendi uchun matnsiz, tugmalar bilan ishlaydigan
to‘liq e-komersiya boti: Telegram **Web App** ichida katalog, mahsulot galereyasi,
o‘lcham tanlash, savatcha, 4 qadamli checkout, buyurtmalar tarixi, admin panel va
kanalga avtomatik buyurtma yuborish.

```
Instagram bio ──► Telegram bot havolasi (`BOT_USERNAME`)
                        │
                        ▼
              /start: brend salomlashuv + tugmalar
                        │
        ┌───────────────┼────────────────────┐
        ▼               ▼                    ▼
  🛍 Katalog      🛒 Savatcham        📦 Buyurtmalarim
   (Web App)       (Web App)            (Web App)
        │
        ▼
  Mahsulot → o‘lcham → savatcha → checkout
        1) Ism + telefon (Telegram kontakti)
        2) Kuryer / Pickup (+ lokatsiya)
        3) Click / Payme / naqd
        4) Tasdiqlash
        │
        ├──► SQLite (orders, order_items)
        ├──► Admin(lar)ga xabar + holat tugmalari
        ├──► ORDERS_CHAT_ID kanaliga buyurtma
        └──► Mijozga tasdiq xabari
```

## 1. Tez ishga tushirish

```bash
npm install
cp .env.example .env      # qiymatlarni to‘ldiring
npm run seed              # 7 kategoriya, 12 demo mahsulot + ONE23 muqovalar
npm start                 # bot polling + web server (port 8080)
```

Talab: **Node.js ≥ 22.5** (`node:sqlite` uchun). Node 22.x da
`NODE_OPTIONS=--experimental-sqlite` kerak bo‘lishi mumkin; Node 23+ da shart emas.

## 2. `.env`

| Kalit | Tavsif |
| --- | --- |
| `BOT_TOKEN` | BotFather tokeni |
| `ADMIN_IDS` | Admin panelga kira oladigan Telegram ID’lar (vergul bilan) |
| `ORDERS_CHAT_ID` | Buyurtmalar tushadigan kanal/guruh (`-100...`) |
| `PUBLIC_URL` | Web App’ning **HTTPS** manzili (Telegram faqat https qabul qiladi) |
| `PORT` | Web server porti (default `8080`) |
| `ALLOW_DEV_WEBAPP` | `true` bo‘lsa faqat **localhost**dan Telegram’siz checkout test qilinadi |
| `DELIVERY_FEE` / `FREE_DELIVERY_FROM` | Yetkazish narxi va bepul yetkazish chegarasi |
| `STORE_*` | Do‘kon manzili, telefoni, xarita havolasi |
| `SUPPORT_USERNAME`, `CHANNEL_URL`, `INSTAGRAM_URL` | Operator/kanal/Instagram havolalari |
| `CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID` | Click kabinetidan (bo‘lsa to‘lov havolasi avtomatik yasaladi) |
| `CLICK_SECRET_KEY` | Click kabinetidagi Secret key — callback imzosini tekshirish uchun |
| `PAYME_MERCHANT_ID` | Payme kabinetidan |
| `PAYME_KEY` | Payme merchant kaliti (Basic auth paroli) |

## 3. Telegram’da sozlash (majburiy qadamlar)

1. **Kanalga botni qo‘shing:** `ORDERS_CHAT_ID` kanaliga botni **administrator** qilib
   qo‘shing (xabar yuborish huquqi bilan). Aks holda Telegram `chat not found` qaytaradi
   va buyurtma kanalga tushmaydi (adminlarga shaxsiy xabar baribir boradi).
2. **Admin `/start` bosishi kerak:** bot faqat foydalanuvchi botni bir marta ochgandan keyin
   unga xabar yubora oladi. Har bir admin bir marta `/start` bosib qo‘ysin.
3. **Web App uchun HTTPS:** `PUBLIC_URL` ni to‘ldiring. Variantlar:
   - **VPS + domen:** `Caddy` yoki `nginx` + Let’s Encrypt (`Caddyfile`: `shop.example.uz { reverse_proxy 127.0.0.1:8080 }`).
   - **Tez test:** `ngrok http 8080` yoki `cloudflared tunnel --url http://localhost:8080`,
     chiqqan `https://...` manzilni `PUBLIC_URL` ga yozib, botni qayta ishga tushiring.
   - **Cloudflare Tunnel + o‘z domeningiz** — doimiy yechim.
4. Botni qayta ishga tushiring — u `setChatMenuButton` orqali pastdagi menyu tugmasini
   ham avtomatik o‘rnatadi.

## 4. Bot oqimi (matnsiz)

- `/start` — brend salomlashuvi (Instagram deep-link `?start=ig` alohida matn beradi) va
  doimiy klaviatura:
  - `🛍 Katalog va Xarid` → Web App katalog
  - `🛒 Savatcham` → Web App savatcha
  - `📦 Buyurtmalarim` → Web App buyurtmalar tarixi
  - `📞 Operator bilan bog‘lanish` → telefon, manzil, menejer/kanal/Instagram havolalari
- Erkin matnli chat yo‘q: har qanday matnga bot “tugmalardan foydalaning” deb javob beradi.
- `/orders` — oxirgi buyurtmalar chatda ham ko‘rinadi.
- Telegram kontaktini ulashish → raqam bazaga saqlanadi va checkout’da avtomatik to‘ladi.
  Lokatsiya ulashish → manzil sifatida saqlanadi.

## 5. Web App

`public/` — build talab qilmaydigan vanilla JS (CSS + JS, framework yo‘q).

- **Katalog:** kategoriya chiplari, 2/3 ustunli grid, narx va eski narx, o‘lchamlar.
- **Mahsulot:** gorizontal foto galereya, tavsif, o‘lcham paneli (S–XXL), soni, savatchaga qo‘shish.
- **Savatcha:** mahsulot + o‘lcham, soni, jami, bepul yetkazishgacha qolgan summa.
- **Checkout:** 4 qadam (aloqa → yetkazish → to‘lov → tasdiq), har qadamda validatsiya,
  Telegram `requestContact` / `requestLocation`, `BackButton`, haptika.
- **Buyurtmalarim:** holat badge’lari (Yangi / Tasdiqlandi / Kuryerda / Yetkazildi / Bekor qilindi).

Telegram tashqarisida (brauzerda) katalog ochiladi, lekin buyurtma yuborish uchun
Telegram ichida ochish kerak (initData bilan imzolangan so‘rov talab qilinadi).

## 6. Admin panel

`/admin` (faqat `ADMIN_IDS`):

- 📊 statistika (bugun / 7 kun / jami, tushum, yangi buyurtmalar)
- 📦 buyurtmalar ro‘yxati, holat bo‘yicha filtr, sahifalash, to‘liq karta
- holat tugmalari: ✅ Tasdiqlash · 🚚 Kuryerga · 📦 Yetkazildi · ❌ Bekor qilish
  (har o‘zgarishda mijozga avtomatik xabar)
- 🏷 mahsulotlar: faollashtirish/yashirish, narxni o‘zgartirish, o‘chirish
- ➕ mahsulot qo‘shish ustasi: rasmlar (bir nechta, Telegram’dan yuklab olinadi yoki URL) →
  nom → kategoriya → narx → o‘lchamlar → tavsif → tasdiqlash

Yangi buyurtma kelganda admin(lar)ga to‘liq karta + holat tugmalari, kanalga esa toza matn
(format: mijoz, telefon, manzil/lokatsiya, mahsulotlar + o‘lchamlar, to‘lov, jami) yuboriladi.

## 7. Arxitektura

```
src/
  config.js        .env → config, yo‘llar, validatsiya
  db.js            node:sqlite sxemasi + barcha so‘rovlar (users, categories, products, orders, order_items)
  auth.js          Telegram WebApp initData HMAC tekshiruvi
  format.js        pul/sana/status formatlash
  orders.js        savatchani serverda qayta hisoblash, buyurtma yaratish, xabarlar
  server.js        Express: /api/*, statik fayllar, /uploads
  index.js         bot polling + server + graceful shutdown
  seed.js          demo katalog
  bot/
    instance.js    grammY bot instansiyasi, isAdmin()
    index.js       handlerlarni ro‘yxatdan o‘tkazish
    user.js        /start, klaviatura, operator, kontakt, lokatsiya
    admin.js       admin panel, buyurtma holatlari, mahsulot ustasi
public/
  index.html, styles.css, app.js
data/              shop.db, uploads/ (gitignored)
```

### API

| Metod | Yo‘l | Tavsif |
| --- | --- | --- |
| `GET` | `/api/health` | holat |
| `GET` | `/api/bootstrap` | kategoriya, mahsulot, sozlamalar, foydalanuvchi |
| `GET` | `/api/me` | telefon/lokatsiya (auth) |
| `GET` | `/api/orders` | foydalanuvchi buyurtmalari (auth) |
| `POST` | `/api/orders` | buyurtma yaratish (auth, 12/soat limit) |
| `POST` | `/click/prepare` · `/click/complete` | Click SHOP-API callback’lari |
| `POST` | `/payme` | Payme Merchant API (JSON-RPC) |

Auth — `X-Init-Data` sarlavhasi; imzo bot tokeni bilan HMAC-SHA256 orqali tekshiriladi,
`auth_date` 24 soatdan eski bo‘lsa rad etiladi. **Narxlar har doim serverda bazadan
qayta hisoblanadi** — mijoz yuborgan summaga ishonilmaydi. O‘lchamlar mahsulotning
o‘lcham ro‘yxatiga mosligi tekshiriladi.

## 7.1 Kanal parseri (Python)

`parser/` — kanaldagi postlarni (rasm/video + caption) o‘qib, mahsulotni o‘sha bazaga yozadigan
Telethon skripti. Manba kanalni `parser/.env` dagi `CHANNEL` va `CHANNEL_USERNAME` orqali sozlang.
`python -m parser watch` bilan: yangi post → katalogda darhol paydo bo‘ladi, o‘chirilgan post →
katalogdan yo‘qoladi (yozuv bazada qoladi, `active = 0`). Batafsil: [`parser/README.md`](parser/README.md).

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r parser/requirements.txt
cp parser/.env.example parser/.env   # api_id / api_hash (my.telegram.org)
python -m parser login               # bir marta
python -m parser sync --limit 20 --dry-run
python -m parser watch
```

**API kalit/sessiyasiz variant:** kanal ochiq bo‘lsa, `t.me/s/<username>` veb-ko‘rinishidan
import qilish mumkin (bot admin bo‘lishi ham shart emas):

```bash
python -m parser web --limit 20 --dry-run
python -m parser web --limit 20
```

Bu rejim real-time emas — yangi postlar uchun buyruqni qayta ishga tushirish kerak.

## 8. To‘lovlar (Click / Payme)

- Checkout’da uchta usul: Click, Payme, yetkazib berishda naqd/karta.
- `CLICK_*` yoki `PAYME_MERCHANT_ID` to‘ldirilgan bo‘lsa, buyurtma yaratilganda to‘lov
  havolasi avtomatik yasaladi (`my.click.uz/services/pay...`, `checkout.paycom.uz/...`),
  mijoz uni «To‘lovni amalga oshirish» tugmasida ko‘radi.
- To‘lov **avtomatik tasdiqlanadi**: Click SHOP-API va Payme Merchant API serverdagi
  endpointlarga murojaat qiladi, imzo/summa tekshiriladi va buyurtma `payment_status = 'paid'`
  bo‘ladi (admin va mijozga «to‘lov qabul qilindi» xabari ketadi).
- Kabinetda callback manzillari sifatida quyidagilarni ko‘rsating:

| Provayder | URL | Kalitlar |
| --- | --- | --- |
| Click SHOP-API | `https://<PUBLIC_URL>/click/prepare` va `/click/complete` | `CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID`, `CLICK_SECRET_KEY` |
| Payme Merchant API | `https://<PUBLIC_URL>/payme` | `PAYME_MERCHANT_ID`, `PAYME_KEY` (Basic auth: login `Paycom`, parol — `PAYME_KEY`) |

- Click imzosi `md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id
  [+ merchant_prepare_id] + amount + action + sign_time)` bo‘yicha tekshiriladi.
- Payme JSON-RPC metodlari: `CheckPerformTransaction`, `CreateTransaction`,
  `PerformTransaction`, `CancelTransaction`, `CheckTransaction`, `GetStatement`;
  summalar tiyinda, holatlar `1` (yaratilgan) / `2` (bajarilgan) / `-1`, `-2` (bekor qilingan).
- Tranzaksiyalar `payment_transactions` jadvalida saqlanadi — provayder qayta so‘rov
  yuborsa (retry), dublikat to‘lov yozilmaydi va javob idempotent bo‘ladi.
- Kalitlar to‘liq bo‘lmasa checkout’da «havola menejer tomonidan yuboriladi» ko‘rinadi;
  to‘lovni baribir admin panelidan qo‘lda tasdiqlash mumkin.

## 9. Deployment (VPS)

```bash
# 1) serverda
git clone <repo> && cd ai_bot-kiyim && npm ci --omit=dev && npm run seed
# 2) systemd
[Unit]
Description=ONE23 shop bot
After=network.target
[Service]
WorkingDirectory=/opt/one23-shop
ExecStart=/usr/bin/node src/index.js
Restart=always
EnvironmentFile=/opt/one23-shop/.env
[Install]
WantedBy=multi-user.target
# 3) Caddy bilan HTTPS
shop.example.uz {
  reverse_proxy 127.0.0.1:8080
}
```

Yoki `pm2 start src/index.js --name one23-shop`.

## 10. Xavfsizlik

- `.env` va `data/` git’ga tushmaydi.
- `ALLOW_DEV_WEBAPP=true` faqat localhost uchun; productionda **o‘chiring**.
- Admin callback’lari `ADMIN_IDS` bo‘yicha tekshiriladi.
- Buyurtma yaratishga rate limit (12 soatiga 1 foydalanuvchi) qo‘yilgan.
- Telegram’dan yuklangan rasmlar token ko‘rsatilmasdan `/uploads/...` orqali beriladi.

## 11. Muammoli holatlar

| Belgi | Yechim |
| --- | --- |
| `chat not found` logda | Botni kanalga administrator qilib qo‘shing, `ORDERS_CHAT_ID` to‘g‘riligini tekshiring |
| Web App tugmalari ko‘rinmaydi | `PUBLIC_URL` https emas yoki bo‘sh — bot `/start`da ogohlantiradi |
| Admin xabar olmaydi | Admin botga `/start` bosmagan |
| `409 Conflict` polling | Bot boshqa joyda ham ishlayapti (eski server/webhook) |
| Rasm ko‘rinmaydi | `PUBLIC_URL` noto‘g‘ri yoki `data/uploads` yo‘q — `npm run seed` |
| Checkout 401 | Telegram ichida ochilmagan (brauzerdan buyurtma berilmaydi) |
