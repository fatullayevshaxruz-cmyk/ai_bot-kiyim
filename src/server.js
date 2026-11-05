import express from 'express'
import { clickReady, config, paymeReady } from './config.js'
import { validateInitData } from './auth.js'
import { getProduct, listCategories, listProducts, listUserOrders, upsertUser } from './db.js'
import { buildPaymentUrl, notifyNewOrder, placeOrder, sendOrderToCustomer, OrderError } from './orders.js'
import { handleClickComplete, handleClickPrepare, handlePayme } from './payments.js'
import { bot } from './bot/instance.js'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

// Dev-rejim faqat haqiqiy lokal brauzerdan ishlaydi. Proksi sarlavhalari (X-Forwarded-*)
// bo'lsa so'rov lokal hisoblanmaydi — aks holda tunnel orqali `X-Forwarded-Host: localhost`
// yuborib, imzosiz so'rovni dev foydalanuvchisi sifatida o'tkazish mumkin edi.
const isLoopback = (req) => {
  const ip = (req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '')
  const proxied =
    req.get('x-forwarded-for') || req.get('x-forwarded-host') || req.get('forwarded') || req.get('x-real-ip')
  if (proxied) return false
  if (ip !== '127.0.0.1' && ip !== '::1') return false
  return LOOPBACK_HOSTS.has((req.hostname ?? '').toLowerCase())
}

function resolveUser(req) {
  const initData = req.get('X-Init-Data') ?? ''
  const fromTelegram = validateInitData(initData, config.botToken)
  if (fromTelegram) return upsertUser(fromTelegram)
  if (config.allowDevWebapp && isLoopback(req)) {
    // Faqat lokal test uchun: Telegram tashqarisida ko'rish
    return upsertUser({ id: 900000001, first_name: 'Lokal', last_name: 'Test', username: 'local_dev' })
  }
  return null
}

const botLink = () => {
  try {
    const username = bot.botInfo?.username
    return username ? `https://t.me/${username}` : ''
  } catch {
    return ''
  }
}

const settingsPayload = () => ({
  deliveryFee: config.deliveryFee,
  freeDeliveryFrom: config.freeDeliveryFrom,
  store: config.store,
  support: config.support,
  botUrl: botLink(),
  payments: {
    click: clickReady,
    payme: paymeReady,
    cod: true,
  },
  brand: { name: 'ONE23' },
})

const orderRateLimit = new Map()

function checkRateLimit(userId) {
  const now = Date.now()
  const windowMs = 60 * 60 * 1000
  const attempts = (orderRateLimit.get(userId) ?? []).filter((timestamp) => now - timestamp < windowMs)
  if (attempts.length >= 12) return false
  attempts.push(now)
  orderRateLimit.set(userId, attempts)
  return true
}

export function createServer() {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '128kb' }))

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }))

  app.get('/api/bootstrap', (req, res) => {
    const user = resolveUser(req)
    res.set('Cache-Control', 'no-store')
    res.json({
      categories: listCategories(),
      products: listProducts(),
      settings: settingsPayload(),
      user: user
        ? { id: user.id, name: user.firstName ?? 'Mijoz', phone: user.phone ?? '', lat: user.lat, lon: user.lon }
        : null,
    })
  })

  app.get('/api/me', (req, res) => {
    const user = resolveUser(req)
    if (!user) return res.status(401).json({ error: 'auth' })
    res.set('Cache-Control', 'no-store')
    res.json({
      user: { id: user.id, name: user.firstName ?? 'Mijoz', phone: user.phone ?? '', lat: user.lat, lon: user.lon },
    })
  })

  app.get('/api/orders', (req, res) => {
    const user = resolveUser(req)
    if (!user) return res.status(401).json({ error: 'auth' })
    res.set('Cache-Control', 'no-store')
    res.json({ orders: listUserOrders(user.id, 20) })
  })

  app.post('/api/orders', async (req, res) => {
    const user = resolveUser(req)
    if (!user) {
      return res.status(401).json({ error: 'Telegram orqali oching', message: 'Buyurtma berish uchun botni Telegramda oching.' })
    }
    if (!checkRateLimit(user.id)) {
      return res.status(429).json({ error: 'rate_limit', message: 'Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring.' })
    }

    try {
      const order = placeOrder(user, req.body ?? {}, (id) => getProduct(id))
      const paymentUrl = buildPaymentUrl(order)
      res.status(201).json({
        order: {
          code: order.code,
          total: order.total,
          itemsTotal: order.itemsTotal,
          deliveryFee: order.deliveryFee,
          payment: order.payment,
          status: order.status,
          paymentUrl,
        },
      })

      // Javob yuborilgandan keyin xabar tarqatamiz — mijozni kutdirmaymiz
      notifyNewOrder(order).catch((error) => console.error('[server] notify xatosi:', error))
      sendOrderToCustomer(order).catch((error) => console.error('[server] mijoz xabari xatosi:', error))
    } catch (error) {
      if (error instanceof OrderError) return res.status(400).json({ error: 'validation', message: error.message })
      console.error('[server] buyurtma yaratishda xatolik:', error)
      res.status(500).json({ error: 'internal', message: 'Buyurtmani saqlashda xatolik. Qayta urinib ko‘ring.' })
    }
  })

  // Click SHOP-API va Payme Merchant API — tashqi to‘lov tizimlari chaqiradigan endpointlar.
  // Javob har doim 200 + JSON: provayder xatoni FAQAT `error` maydonidan o‘qiydi.
  app.post('/click/prepare', express.urlencoded({ extended: false }), (req, res) => {
    res.json(handleClickPrepare(req.body ?? {}))
  })
  app.post('/click/complete', express.urlencoded({ extended: false }), (req, res) => {
    res.json(handleClickComplete(req.body ?? {}))
  })
  app.post('/payme', (req, res) => {
    res.json(handlePayme(req.body ?? {}, req.get('authorization') ?? ''))
  })

  app.use('/uploads', express.static(config.uploadsDir, { maxAge: '7d', fallthrough: true }))
  // HTML/CSS/JS har safar ETag bilan qayta tekshiriladi: fayl o'zgarmagan bo'lsa 304,
  // o'zgargan bo'lsa darhol yangi versiya. Telegram WebView kuchli keshlagani uchun
  // `max-age: 1h` bilan yangilanishlar foydalanuvchiga yetib bormasdi.
  app.use(express.static(config.publicDir, { extensions: ['html'], maxAge: 0 }))

  // SPA fallback (Express 5: wildcard o'rniga middleware)
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next()
    res.sendFile('index.html', { root: config.publicDir })
  })

  app.use((req, res) => res.status(404).json({ error: 'not_found' }))

  app.use((error, _req, res, _next) => {
    console.error('[server] xatosi:', error)
    res.status(500).json({ error: 'internal' })
  })

  return app
}
