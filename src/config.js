import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const envFile = path.join(ROOT, '.env')
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile)
  } catch (err) {
    console.warn('[config] .env o‘qilmadi:', err.message)
  }
}

const text = (value, fallback = '') => (value ?? fallback).toString().trim()
const number = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
const idList = (value) =>
  text(value)
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry !== 0)

const publicUrl = text(process.env.PUBLIC_URL).replace(/\/+$/, '')
const supportUsername = text(process.env.SUPPORT_USERNAME).replace(/^@/, '')

// Ba'zi muhitlarda PORT=0 turadi va .env qiymatini bosib ketadi (process.loadEnvFile mavjud
// o'zgaruvchilarni almashtirmaydi). 0 yoki noto'g'ri qiymat tasodifiy portga olib kelib,
// Web App manzilini buzadi — shuning uchun standart 8080 ga qaytaramiz.
const rawPort = number(process.env.PORT, 8080)
const port = rawPort >= 1 && rawPort <= 65535 ? rawPort : 8080

export const config = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  dataDir: path.join(ROOT, 'data'),
  uploadsDir: path.join(ROOT, 'data', 'uploads'),
  dbFile: process.env.DB_FILE ? path.resolve(ROOT, process.env.DB_FILE) : path.join(ROOT, 'data', 'shop.db'),

  botToken: text(process.env.BOT_TOKEN),
  adminIds: idList(process.env.ADMIN_IDS),
  ordersChatId: text(process.env.ORDERS_CHAT_ID),

  publicUrl,
  port,
  allowDevWebapp: text(process.env.ALLOW_DEV_WEBAPP).toLowerCase() === 'true',

  deliveryFee: number(process.env.DELIVERY_FEE, 25000),
  freeDeliveryFrom: number(process.env.FREE_DELIVERY_FROM, 0),

  store: {
    address: text(process.env.STORE_ADDRESS, 'Toshkent sh.'),
    landmark: text(process.env.STORE_LANDMARK),
    phone: text(process.env.STORE_PHONE),
    locationUrl: text(process.env.STORE_LOCATION_URL),
  },
  support: {
    username: supportUsername,
    url: supportUsername ? `https://t.me/${supportUsername}` : '',
    channelUrl: text(process.env.CHANNEL_URL),
    instagramUrl: text(process.env.INSTAGRAM_URL),
  },
  payments: {
    click: {
      serviceId: text(process.env.CLICK_SERVICE_ID),
      merchantId: text(process.env.CLICK_MERCHANT_ID),
      secretKey: text(process.env.CLICK_SECRET_KEY),
    },
    payme: { merchantId: text(process.env.PAYME_MERCHANT_ID), key: text(process.env.PAYME_KEY) },
  },
}

// Onlayn to‘lov faqat kabinet kalitlari to‘liq bo‘lsa avtomatik tasdiqlanadi.
export const clickReady = Boolean(
  config.payments.click.serviceId && config.payments.click.merchantId && config.payments.click.secretKey,
)
export const paymeReady = Boolean(config.payments.payme.merchantId && config.payments.payme.key)

export const isPublicUrlReady = /^https:\/\//i.test(config.publicUrl)

export function assertConfig() {
  const problems = []
  if (!config.botToken) problems.push('BOT_TOKEN bo‘sh')
  if (!config.adminIds.length) problems.push('ADMIN_IDS bo‘sh')
  if (!isPublicUrlReady) problems.push('PUBLIC_URL https manzil emas (Web App tugmalari ishlamaydi)')
  if ((config.payments.click.serviceId || config.payments.click.merchantId) && !config.payments.click.secretKey) {
    problems.push('CLICK_SECRET_KEY bo‘sh — Click callback imzosi tekshirilmaydi')
  }
  if (config.payments.payme.merchantId && !config.payments.payme.key) {
    problems.push('PAYME_KEY bo‘sh — Payme callback’i ishlamaydi')
  }
  return problems
}

fs.mkdirSync(config.uploadsDir, { recursive: true })
