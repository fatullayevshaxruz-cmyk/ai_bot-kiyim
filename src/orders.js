import { InlineKeyboard } from 'grammy'
import { config } from './config.js'
import { createOrder, setUserPhone } from './db.js'
import { money, statusLabel, PAYMENT_LABELS, DELIVERY_LABELS, dateTime } from './format.js'
import { bot } from './bot/instance.js'

const PAYMENTS = new Set(['click', 'payme', 'cash'])
const DELIVERIES = new Set(['courier', 'pickup'])

export class OrderError extends Error {}

export function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.length === 9 && digits.startsWith('9')) return `+998${digits}`
  if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`
  if (digits.length === 13 && digits.startsWith('998')) return `+${digits.slice(1)}`
  return null
}

export function buildPaymentUrl(order) {
  if (order.payment === 'click' && config.payments.click.serviceId && config.payments.click.merchantId) {
    const params = new URLSearchParams({
      service_id: config.payments.click.serviceId,
      merchant_id: config.payments.click.merchantId,
      amount: String(order.total),
      transaction_param: order.code,
      return_url: config.publicUrl ? `${config.publicUrl}/?view=orders` : 'https://t.me',
    })
    return `https://my.click.uz/services/pay?${params.toString()}`
  }
  if (order.payment === 'payme' && config.payments.payme.merchantId) {
    const raw = `m=${config.payments.payme.merchantId};ac.order_id=${order.code};a=${order.total * 100}`
    return `https://checkout.paycom.uz/${Buffer.from(raw).toString('base64')}`
  }
  return null
}

/**
 * Web App'dan kelgan savatchani serverda qayta hisoblaydi, tekshiradi va buyurtma yaratadi.
 * Narxlar har doim bazadan olinadi — mijoz yuborgan narxga ishonilmaydi.
 */
export function placeOrder(user, payload, productLookup) {
  const items = Array.isArray(payload?.items) ? payload.items : []
  if (!items.length) throw new OrderError('Savatcha bo‘sh.')
  if (items.length > 30) throw new OrderError('Savatchadagi mahsulotlar soni juda ko‘p.')

  const normalized = []
  for (const raw of items) {
    const product = productLookup(Number(raw?.productId))
    if (!product || !product.active) continue
    const qty = Math.min(Math.max(Number(raw?.qty) || 1, 1), 10)
    const sizes = Array.isArray(product.sizes) ? product.sizes : []
    let size = raw?.size ? String(raw.size) : null
    if (sizes.length) {
      if (!size || !sizes.includes(size)) {
        throw new OrderError(`«${product.title}» uchun o‘lcham tanlanmagan.`)
      }
    } else {
      size = null
    }
    normalized.push({
      productId: product.id,
      title: product.title,
      price: product.price,
      size,
      qty,
    })
  }
  if (!normalized.length) throw new OrderError('Tanlangan mahsulotlar topilmadi.')

  const customerName = String(payload?.customerName ?? '').trim().slice(0, 60)
  if (customerName.length < 2) throw new OrderError('Ismni to‘liq kiriting.')

  const phone = normalizePhone(payload?.phone)
  if (!phone) throw new OrderError('Telefon raqam formati xato (+998 XX XXX XX XX).')

  const delivery = String(payload?.delivery ?? '');
  if (!DELIVERIES.has(delivery)) throw new OrderError('Yetkazib berish usulini tanlang.')

  const address = String(payload?.address ?? '').trim().slice(0, 200)
  const lat = Number.isFinite(Number(payload?.lat)) ? Number(payload.lat) : null
  const lon = Number.isFinite(Number(payload?.lon)) ? Number(payload.lon) : null
  if (delivery === 'courier' && address.length < 5 && !(lat && lon)) {
    throw new OrderError('Manzilni kiriting yoki lokatsiyani ulashing.')
  }

  const payment = String(payload?.payment ?? '');
  if (!PAYMENTS.has(payment)) throw new OrderError('To‘lov usulini tanlang.')

  const itemsTotal = normalized.reduce((sum, item) => sum + item.price * item.qty, 0)
  const freeDelivery = config.freeDeliveryFrom > 0 && itemsTotal >= config.freeDeliveryFrom
  const deliveryFee = delivery === 'pickup' || freeDelivery ? 0 : config.deliveryFee

  const order = createOrder({
    user,
    customerName,
    phone,
    delivery,
    address: delivery === 'courier' ? address : '',
    lat: delivery === 'courier' ? lat : null,
    lon: delivery === 'courier' ? lon : null,
    payment,
    items: normalized,
    deliveryFee,
    comment: String(payload?.comment ?? '').trim().slice(0, 300),
  })

  setUserPhone(user.id, phone)
  return order
}

/* ------------------------------- xabarlar -------------------------------- */

export function orderMessage(order, { forAdmin = false } = {}) {
  const lines = []
  lines.push(`🆕 <b>Yangi buyurtma ${order.code}</b>`, '')
  lines.push(`👤 Mijoz: <b>${escapeHtml(order.customerName)}</b>`)
  lines.push(`📞 Telefon: <code>${order.phone}</code>`)
  lines.push(`🆔 Telegram: ${order.userId}${order.username ? ` (@${order.username})` : ''}`)
  lines.push('')
  lines.push(`📍 Yetkazish: <b>${DELIVERY_LABELS[order.delivery]}</b>`)
  if (order.delivery === 'courier') {
    lines.push(`🏠 Manzil: ${escapeHtml(order.address || '—')}`)
    if (order.lat && order.lon) {
      lines.push(`🗺 Lokatsiya: https://yandex.uz/maps/?pt=${order.lon},${order.lat}&z=17`)
    }
  } else {
    lines.push(`🏬 Do‘kon: ${escapeHtml(config.store.address)}`)
  }
  lines.push('')
  lines.push('🛍 <b>Mahsulotlar</b>')
  order.items.forEach((item, index) => {
    const size = item.size ? ` — o‘lcham ${item.size}` : ''
    lines.push(`  ${index + 1}. ${escapeHtml(item.title)}${size} × ${item.qty} = ${money(item.price * item.qty)}`)
  })
  lines.push('')
  lines.push(`💰 Mahsulotlar: ${money(order.itemsTotal)}`)
  lines.push(`🚚 Yetkazish: ${order.deliveryFee ? money(order.deliveryFee) : 'Bepul'}`)
  const paymentState =
    order.payment === 'cash'
      ? 'yetkazishda'
      : order.paymentStatus === 'paid'
        ? '✅ to‘langan'
        : order.paymentStatus === 'cancelled'
          ? '❌ bekor qilingan'
          : '⏳ kutilmoqda'
  lines.push(`💳 To‘lov: <b>${PAYMENT_LABELS[order.payment]}</b> · ${paymentState}`)
  lines.push(`✅ <b>Jami: ${money(order.total)}</b>`)
  if (order.comment) lines.push(`📝 Izoh: ${escapeHtml(order.comment)}`)
  lines.push('')
  lines.push(`🕒 ${dateTime(order.createdAt)}`)
  if (forAdmin) lines.push(`📌 Holat: ${statusLabel(order.status)}`)
  return lines.join('\n')
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** Kanalga (obuna) va adminlarga buyurtmani uzatadi. */
export async function notifyNewOrder(order) {
  const text = orderMessage(order, { forAdmin: true })
  const results = { channel: null, admins: 0 }

  if (config.ordersChatId) {
    try {
      await bot.api.sendMessage(config.ordersChatId, text, { parse_mode: 'HTML' })
      results.channel = 'ok'
    } catch (error) {
      results.channel = error.message
      console.error('[orders] kanalga yuborilmadi:', error.message)
    }
  }

  const keyboard = orderKeyboard(order.id)
  for (const adminId of config.adminIds) {
    try {
      await bot.api.sendMessage(adminId, text, { parse_mode: 'HTML', reply_markup: keyboard })
      results.admins += 1
    } catch (error) {
      console.error(`[orders] admin ${adminId}ga yuborilmadi:`, error.message)
    }
  }
  return results
}

export function orderKeyboard(orderId) {
  return new InlineKeyboard()
    .text('✅ Tasdiqlash', `adm:status:${orderId}:confirmed`)
    .text('🚚 Kuryerga', `adm:status:${orderId}:shipping`)
    .row()
    .text('📦 Yetkazildi', `adm:status:${orderId}:delivered`)
    .text('❌ Bekor qilish', `adm:status:${orderId}:cancelled`)
}

export async function sendOrderToCustomer(order) {
  const text = [
    `✅ <b>Buyurtmangiz qabul qilindi</b>`,
    '',
    `🔖 Raqam: <b>${order.code}</b>`,
    `💳 To‘lov: ${PAYMENT_LABELS[order.payment]}`,
    `💰 Jami: <b>${money(order.total)}</b>`,
    '',
    'Menejerimiz tez orada tasdiqlash uchun bog‘lanadi.',
    'Buyurtma holatini «📦 Buyurtmalarim» bo‘limida kuzatishingiz mumkin.',
  ].join('\n')
  try {
    await bot.api.sendMessage(order.userId, text, { parse_mode: 'HTML' })
  } catch (error) {
    console.error('[orders] mijozga xabar yuborilmadi:', error.message)
  }
}

export async function notifyPaymentReceived(order) {
  if (!order) return
  const text = [
    '💰 <b>To‘lov qabul qilindi</b>',
    '',
    `🔖 Buyurtma: <b>${order.code}</b>`,
    `💳 Usul: ${PAYMENT_LABELS[order.payment]}`,
    `✅ Jami: <b>${money(order.total)}</b>`,
  ].join('\n')

  for (const adminId of config.adminIds) {
    try {
      await bot.api.sendMessage(adminId, text, { parse_mode: 'HTML' })
    } catch (error) {
      console.error(`[orders] to‘lov xabari admin ${adminId}ga yuborilmadi:`, error.message)
    }
  }
  try {
    await bot.api.sendMessage(
      order.userId,
      `✅ <b>To‘lov qabul qilindi</b>\n\n🔖 ${order.code}\n💰 ${money(order.total)}\n\nBuyurtmangiz tayyorlanmoqda. Holatini «📦 Buyurtmalarim» bo‘limida kuzating.`,
      { parse_mode: 'HTML' },
    )
  } catch (error) {
    console.error('[orders] to‘lov tasdig‘i mijozga yuborilmadi:', error.message)
  }
}

export async function notifyStatusChange(order, previousStatus) {
  if (order.status === previousStatus) return
  const messages = {
    confirmed: `✅ Buyurtmangiz tasdiqlandi!\n\n🔖 ${order.code}\nTez orada kuryerga topshiriladi.`,
    shipping: `🚚 Buyurtmangiz kuryerga topshirildi.\n\n🔖 ${order.code}\nJami: ${money(order.total)}\nKuryer siz bilan bog‘lanadi.`,
    delivered: `📦 Buyurtmangiz yetkazildi. Xaridingiz uchun rahmat! 🤍\n\n🔖 ${order.code}`,
    cancelled: `❌ Afsuski, ${order.code} raqamli buyurtma bekor qilindi.\n\nSavollaringiz bo‘lsa operator bilan bog‘laning.`,
  }
  const text = messages[order.status]
  if (!text) return
  try {
    await bot.api.sendMessage(order.userId, text, { parse_mode: 'HTML' })
  } catch (error) {
    console.error('[orders] holat xabari yuborilmadi:', error.message)
  }
}
