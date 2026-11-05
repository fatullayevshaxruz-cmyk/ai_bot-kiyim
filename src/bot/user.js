import { InlineKeyboard, Keyboard } from 'grammy'
import { config, isPublicUrlReady } from '../config.js'
import { upsertUser, setUserPhone, setUserLocation, listUserOrders } from '../db.js'
import { money, dateTime, statusLabel } from '../format.js'
import { normalizePhone } from '../orders.js'

export function mainKeyboard() {
  const keyboard = new Keyboard()
  if (isPublicUrlReady) {
    keyboard
      .webApp('🛍 Katalog va Xarid', `${config.publicUrl}/?view=catalog`)
      .row()
      .webApp('🛒 Savatcham', `${config.publicUrl}/?view=cart`)
      .webApp('📦 Buyurtmalarim', `${config.publicUrl}/?view=orders`)
      .row()
  }
  keyboard.text('📞 Operator bilan bog‘lanish')
  return keyboard.resized().persistent()
}

function welcomeText(firstName, fromInstagram) {
  const name = firstName ? `, ${firstName}` : ''
  const intro = fromInstagram
    ? '📸 <b>Instagram</b>dan keldingiz — to‘g‘ri joydasiz!'
    : '✦ <b>STANDART UZBEKISTAN</b>'
  return [
    intro,
    '',
    `Assalomu alaykum${name}! 👋`,
    'Sifatli erkaklar kiyimlari kolleksiyasi endi Telegram ichida.',
    '',
    '🛍 Katalogdan model va o‘lchamni tanlang',
    '🛒 Savatchaga qo‘shing',
    '🚚 1 daqiqada buyurtma bering',
    '',
    'Pastdagi <b>«🛍 Katalog va Xarid»</b> tugmasini bosing 👇',
  ].join('\n')
}

function supportKeyboard() {
  const keyboard = new InlineKeyboard()
  if (config.support.url) keyboard.url('💬 Menejerga yozish', config.support.url).row()
  if (config.store.locationUrl) keyboard.url('🗺 Do‘kon manzili', config.store.locationUrl).row()
  if (config.support.channelUrl) keyboard.url('📢 Kanal', config.support.channelUrl)
  if (config.support.instagramUrl) keyboard.url('📸 Instagram', config.support.instagramUrl)
  return keyboard
}

// Bo'sh inline klaviatura yuborilsa Telegram 400 qaytaradi — shuning uchun tugma bo'lmasa
// reply_markup umuman yuborilmaydi. grammY bo'sh klaviaturani [[]] ko'rinishida saqlaydi,
// shuning uchun qatorlar emas, ichidagi tugmalar tekshiriladi.
export const supportMarkup = () => {
  const keyboard = supportKeyboard()
  const hasButtons = keyboard.inline_keyboard.some((row) => row.length > 0)
  return hasButtons ? keyboard : undefined
}

export function registerUserHandlers(bot) {
  bot.command('start', async (ctx) => {
    const user = upsertUser(ctx.from)
    const payload = (ctx.match ?? '').toString().trim().toLowerCase()
    await ctx.reply(welcomeText(user?.firstName, payload === 'ig' || payload === 'instagram'), {
      parse_mode: 'HTML',
      reply_markup: mainKeyboard(),
    })
    if (!isPublicUrlReady) {
      await ctx.reply(
        '⚠️ <b>Sozlash kerak:</b> Web App katalogi ochilishi uchun .env faylida <code>PUBLIC_URL</code> ga HTTPS manzil yozing (README.md ga qarang).',
        { parse_mode: 'HTML' },
      )
    }
  })

  bot.command('help', (ctx) => ctx.reply(helpText(), { parse_mode: 'HTML', reply_markup: supportMarkup() }))
  bot.command('support', (ctx) => ctx.reply(helpText(), { parse_mode: 'HTML', reply_markup: supportMarkup() }))

  bot.command('orders', async (ctx) => {
    const orders = listUserOrders(ctx.from.id, 5)
    if (!orders.length) {
      return ctx.reply('📦 Hozircha buyurtmalaringiz yo‘q.\n\nKatalogdan xaridni boshlang 👇', {
        reply_markup: mainKeyboard(),
      })
    }
    const text = orders
      .map(
        (order) =>
          `<b>${order.code}</b> · ${statusLabel(order.status)}\n${money(order.total)} · ${dateTime(order.createdAt)}`,
      )
      .join('\n\n')
    return ctx.reply(`📦 <b>Oxirgi buyurtmalaringiz</b>\n\n${text}`, {
      parse_mode: 'HTML',
      reply_markup: mainKeyboard(),
    })
  })

  bot.hears('📞 Operator bilan bog‘lanish', (ctx) =>
    ctx.reply(helpText(), { parse_mode: 'HTML', reply_markup: supportMarkup() }),
  )

  bot.on('message:contact', async (ctx) => {
    const contact = ctx.message.contact
    if (contact.user_id && contact.user_id !== ctx.from.id) {
      return ctx.reply('Iltimos, o‘zingizning raqamingizni ulashing.')
    }
    const phone = normalizePhone(contact.phone_number)
    if (!phone) return ctx.reply('Raqamni o‘qib bo‘lmadi, Web App ichida qo‘lda kiriting.')
    upsertUser(ctx.from)
    setUserPhone(ctx.from.id, phone)
    await ctx.reply(
      `✅ Raqamingiz saqlandi: <code>${phone}</code>\n\nEndi Web Appga qaytib buyurtmani yakunlashingiz mumkin.`,
      { parse_mode: 'HTML', reply_markup: mainKeyboard() },
    )
  })

  bot.on('message:location', async (ctx) => {
    const { latitude, longitude } = ctx.message.location
    upsertUser(ctx.from)
    setUserLocation(ctx.from.id, latitude, longitude)
    await ctx.reply('📍 Lokatsiya saqlandi. Buyurtmani yakunlash uchun Web Appga qayting.', {
      reply_markup: mainKeyboard(),
    })
  })

  // Matnli chat yo‘q: faqat tugmalar bilan ishlaydigan oqim
  bot.on('message:text', (ctx) =>
    ctx.reply('Iltimos, pastdagi tugmalardan foydalaning 🙌', { reply_markup: mainKeyboard() }),
  )
}

function helpText() {
  const lines = ['📞 <b>Yordam va aloqa</b>', '']
  if (config.store.phone) lines.push(`🏷 Do‘kon telefoni: <code>${config.store.phone}</code>`)
  if (config.store.address) lines.push(`🏬 Manzil: ${config.store.address}`)
  if (config.store.landmark) lines.push(`📍 ${config.store.landmark}`)
  lines.push('', '🕘 Har kuni 09:00 — 20:00', '', 'Menejerimiz buyurtma, o‘lcham va yetkazish bo‘yicha yordam beradi.')
  return lines.join('\n')
}

export { welcomeText }
