import fs from 'node:fs/promises'
import path from 'node:path'
import { InlineKeyboard } from 'grammy'
import { config } from '../config.js'
import { isAdmin } from './instance.js'
import {
  categoriesForAdmin,
  countOrders,
  createProduct,
  deleteProduct,
  getOrder,
  getProduct,
  listOrders,
  listProducts,
  setOrderStatus,
  stats,
  updateProduct,
} from '../db.js'
import { dateTime, money, statusLabel } from '../format.js'
import { buildPaymentUrl, notifyStatusChange, orderKeyboard, orderMessage } from '../orders.js'
import { mediaSummary, sendProductMedia } from './media.js'

const PAGE_SIZE = 6
export const sessions = new Map()

/* -------------------------------- yordamchi ------------------------------- */

// Bot API orqali 20 MB dan katta faylni yuklab bo'lmaydi — videolar uchun bu chegarani
// oldindan tekshiramiz, aks holda admin "file is too big" xatosini tushunmay qoladi.
async function downloadFile(ctx, fileMeta, fallbackExt = '.jpg') {
  if ((fileMeta.file_size ?? 0) > 20 * 1024 * 1024) {
    throw new Error('fayl 20 MB dan katta — uni https://... havola sifatida yuboring')
  }
  const file = await ctx.api.getFile(fileMeta.file_id)
  if (!file?.file_path) throw new Error('file_path topilmadi')
  const response = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`)
  if (!response.ok) throw new Error(`fayl yuklanmadi: HTTP ${response.status}`)
  const ext = (file.file_path.match(/\.[a-z0-9]+$/i)?.[0] ?? fallbackExt).toLowerCase()
  const name = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
  await fs.writeFile(path.join(config.uploadsDir, name), Buffer.from(await response.arrayBuffer()))
  return `/uploads/${name}`
}

const parsePrice = (text) => {
  const digits = String(text).replace(/\D/g, '')
  const value = Number(digits)
  return Number.isFinite(value) && value > 0 ? value : null
}

/* --------------------------------- panel ---------------------------------- */

function panelText() {
  const s = stats()
  return [
    '⚙️ <b>ONE23 — Admin panel</b>',
    '',
    `🆕 Yangi buyurtmalar: <b>${s.newOrders}</b>`,
    `📅 Bugun: ${s.today.orders} buyurtma · ${money(s.today.revenue)}`,
    `🗓 7 kun: ${s.week.orders} buyurtma · ${money(s.week.revenue)}`,
    `👥 Foydalanuvchilar: ${s.users}`,
    `🏷 Faol mahsulotlar: ${s.products}`,
  ].join('\n')
}

function panelKeyboard() {
  const s = stats()
  return new InlineKeyboard()
    .text(`🆕 Yangi buyurtmalar (${s.newOrders})`, 'adm:list:new:0')
    .row()
    .text('📦 Barcha buyurtmalar', 'adm:list:all:0')
    .text('📊 Statistika', 'adm:stats')
    .row()
    .text('🏷 Mahsulotlar', 'adm:products:0')
    .text('➕ Mahsulot qo‘shish', 'p:add')
}

function ordersList(status, page) {
  const filter = status === 'all' ? null : status
  const total = countOrders(filter)
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const safePage = Math.min(Math.max(page, 0), pages - 1)
  const orders = listOrders({ status: filter, limit: PAGE_SIZE, offset: safePage * PAGE_SIZE })

  if (!orders.length) {
    return {
      text: '📭 Bu bo‘limda buyurtmalar yo‘q.',
      keyboard: new InlineKeyboard().text('⬅️ Panel', 'adm:home'),
    }
  }

  const lines = [
    `📦 <b>${status === 'all' ? 'Barcha buyurtmalar' : statusLabel(status)}</b> — ${total} ta (${safePage + 1}/${pages})`,
    '',
    ...orders.map(
      (order) =>
        `<b>${order.code}</b> · ${money(order.total)}\n${order.customerName} · ${statusLabel(order.status)} · ${dateTime(order.createdAt)}`,
    ),
  ]

  const keyboard = new InlineKeyboard()
  for (const order of orders) {
    keyboard.text(`${order.code} · ${money(order.total)}`, `adm:order:${order.id}`).row()
  }
  if (pages > 1) {
    if (safePage > 0) keyboard.text('⬅️', `adm:list:${status}:${safePage - 1}`)
    keyboard.text(`${safePage + 1}/${pages}`, 'adm:noop')
    if (safePage < pages - 1) keyboard.text('➡️', `adm:list:${status}:${safePage + 1}`)
    keyboard.row()
  }
  keyboard.text('🆕 Yangi', 'adm:list:new:0').text('📦 Barchasi', 'adm:list:all:0').row()
  keyboard.text('⬅️ Panel', 'adm:home')
  return { text: lines.join('\n'), keyboard }
}

function orderDetailView(order) {
  const text = orderMessage(order, { forAdmin: true })
  const keyboard = orderKeyboard(order.id)
    .row()
    .text('⬅️ Ro‘yxatga', 'adm:list:all:0')
    .text('🔄 Yangilash', `adm:order:${order.id}`)
  if (order.payment !== 'cash' && buildPaymentUrl(order)) {
    keyboard.row().url('💳 To‘lov havolasi', buildPaymentUrl(order))
  }
  return { text, keyboard }
}

function statsView() {
  const s = stats()
  const text = [
    '📊 <b>Statistika</b>',
    '',
    `📅 Bugun: <b>${s.today.orders}</b> buyurtma · ${money(s.today.revenue)}`,
    `🗓 7 kun: <b>${s.week.orders}</b> buyurtma · ${money(s.week.revenue)}`,
    `📈 Jami: <b>${s.all.orders}</b> buyurtma · ${money(s.all.revenue)}`,
    '',
    `🆕 Tasdiqlanmagan: ${s.newOrders}`,
    `👥 Foydalanuvchilar: ${s.users}`,
    `🏷 Faol mahsulotlar: ${s.products}`,
  ].join('\n')
  return { text, keyboard: new InlineKeyboard().text('⬅️ Panel', 'adm:home') }
}

function productsView(page) {
  const products = listProducts({ includeInactive: true })
  const pages = Math.max(1, Math.ceil(products.length / PAGE_SIZE))
  const safePage = Math.min(Math.max(page, 0), pages - 1)
  const slice = products.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  const lines = [
    `🏷 <b>Mahsulotlar</b> — ${products.length} ta (${safePage + 1}/${pages})`,
    '',
    'Mahsulotni tahrirlash uchun ustiga bosing.',
  ]
  const keyboard = new InlineKeyboard()
  for (const product of slice) {
    keyboard
      .text(`${product.active ? '🟢' : '🔴'} ${product.title} · ${money(product.price)}`, `adm:prod:${product.id}`)
      .row()
  }
  if (pages > 1) {
    if (safePage > 0) keyboard.text('⬅️', `adm:products:${safePage - 1}`)
    if (safePage < pages - 1) keyboard.text('➡️', `adm:products:${safePage + 1}`)
    keyboard.row()
  }
  keyboard.text('➕ Qo‘shish', 'p:add').text('⬅️ Panel', 'adm:home')
  return { text: lines.join('\n'), keyboard }
}

// Kanal postida rasm va video aralash bo'ladi — admin ham ikkalasini ko'rsin
function mediaLine(images) {
  const { photos, videos } = mediaSummary(images)
  if (!photos && !videos) return '🖼 Media: yo‘q'
  if (!videos) return `🖼 Rasmlar: ${photos} ta`
  return `🖼 Rasmlar: ${photos} ta · 🎬 Video: ${videos} ta`
}

function productDetailView(id) {
  const product = getProduct(id)
  if (!product) {
    return { text: 'Mahsulot topilmadi.', keyboard: new InlineKeyboard().text('⬅️ Mahsulotlar', 'adm:products:0') }
  }
  const text = [
    `${product.active ? '🟢 Faol' : '🔴 Yashirin'} · #${product.id}`,
    '',
    `<b>${product.title}</b>`,
    `💵 ${money(product.price)}`,
    `📏 O‘lchamlar: ${product.sizes.length ? product.sizes.join(', ') : 'yo‘q'}`,
    mediaLine(product.images),
    product.description ? `\n${product.description}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const keyboard = new InlineKeyboard()
    .text(product.active ? '🔴 Yashirish' : '🟢 Faollashtirish', `p:toggle:${product.id}`)
    .row()
    .text('💵 Narxni o‘zgartirish', `p:price:${product.id}`)
    .text('🗑 O‘chirish', `p:del:${product.id}`)
    .row()
    .text('⬅️ Mahsulotlar', 'adm:products:0')
  return { text, keyboard }
}

/* ------------------------------- callbacklar ------------------------------ */

async function handleAdminCallback(ctx) {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Ruxsat yo‘q', show_alert: true })
  const data = ctx.callbackQuery.data
  const [, action, arg1, arg2] = data.split(':')

  try {
    if (data === 'adm:noop') return ctx.answerCallbackQuery()
    if (action === 'home') {
      await ctx.answerCallbackQuery()
      return ctx.editMessageText(panelText(), { parse_mode: 'HTML', reply_markup: panelKeyboard() })
    }
    if (action === 'stats') {
      const view = statsView()
      await ctx.answerCallbackQuery()
      return ctx.editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard })
    }
    if (action === 'list') {
      const view = ordersList(arg1, Number(arg2) || 0)
      await ctx.answerCallbackQuery()
      return ctx.editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard })
    }
    if (action === 'order') {
      const found = getOrder(Number(arg1))
      if (!found) return ctx.answerCallbackQuery({ text: 'Buyurtma topilmadi', show_alert: true })
      const view = orderDetailView(found)
      await ctx.answerCallbackQuery()
      return ctx.editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard })
    }
    if (action === 'status') {
      const order = getOrder(Number(arg1))
      if (!order) return ctx.answerCallbackQuery({ text: 'Buyurtma topilmadi', show_alert: true })
      const previous = order.status
      const updated = setOrderStatus(order.id, arg2)
      await ctx.answerCallbackQuery({ text: `Holat: ${statusLabel(updated.status)}` })
      const view = orderDetailView(updated)
      await ctx.editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard }).catch(() => {})
      await notifyStatusChange(updated, previous)
      if (updated.status === 'confirmed' && updated.payment !== 'cash') {
        const payableUrl = buildPaymentUrl(updated)
        if (payableUrl) {
          await ctx.api
            .sendMessage(
              updated.userId,
              `💳 <b>To‘lov havolasi</b>\n\n🔖 ${updated.code}\n💰 ${money(updated.total)}\n\nTo‘lovni yakunlash uchun tugmani bosing.`,
              {
                parse_mode: 'HTML',
                reply_markup: new InlineKeyboard().url('💳 To‘lash', payableUrl),
              },
            )
            .catch(() => {})
        }
      }
      return
    }
    if (action === 'products') {
      const view = productsView(Number(arg1) || 0)
      await ctx.answerCallbackQuery()
      return ctx.editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard })
    }
    if (action === 'prod') {
      const product = getProduct(Number(arg1))
      const view = productDetailView(Number(arg1))
      await ctx.answerCallbackQuery()
      // Media bor bo'lsa — kanaldagi kabi albom ko'rinishida ko'rsatamiz
      const sent = await sendProductMedia(ctx.api, ctx.chat.id, product?.images ?? [], {
        caption: view.text,
        replyMarkup: view.keyboard,
      })
      if (sent.mode !== 'none') return
      return ctx.editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard })
    }
    return ctx.answerCallbackQuery()
  } catch (error) {
    console.error('[admin] callback xatosi:', error)
    return ctx.answerCallbackQuery({ text: 'Xatolik yuz berdi', show_alert: true }).catch(() => {})
  }
}

export async function handleProductCallback(ctx) {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Ruxsat yo‘q', show_alert: true })
  const data = ctx.callbackQuery.data
  const [, action, arg1] = data.split(':')
  const adminId = ctx.from.id

  try {
    if (action === 'add') {
      sessions.set(adminId, {
        step: 'images',
        startedAt: Date.now(),
        data: { images: [], title: '', categoryId: null, price: 0, sizes: [], description: '' },
      })
      await ctx.answerCallbackQuery()
      return ctx.reply(
        [
          '➕ <b>Yangi mahsulot</b> — 1/6 qadam',
          '',
          'Mahsulot rasmlarini va videolarini yuboring (bir nechta bo‘lishi mumkin).',
          'Telegram rasm/video sifatida yoki https://... havola ko‘rinishida.',
        ].join('\n'),
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('✅ Rasmlar tayyor', 'p:imgdone') },
      )
    }
    if (action === 'imgdone') {
      const session = sessions.get(adminId)
      if (!session || session.step !== 'images') return ctx.answerCallbackQuery({ text: 'Jarayon faol emas' })
      session.step = 'title'
      await ctx.answerCallbackQuery()
      return ctx.reply('2/6 — Mahsulot nomini yozing (masalan: Klassik kostyum «Atlas»).')
    }
    if (action === 'cat') {
      const session = sessions.get(adminId)
      if (!session || session.step !== 'category') return ctx.answerCallbackQuery({ text: 'Jarayon faol emas' })
      session.data.categoryId = Number(arg1)
      session.step = 'price'
      await ctx.answerCallbackQuery()
      return ctx.reply('4/6 — Narxini so‘mda yozing (masalan: 1290000).')
    }
    if (action === 'save') {
      const session = sessions.get(adminId)
      if (!session) return ctx.answerCallbackQuery({ text: 'Jarayon faol emas' })
      const data2 = session.data
      const product = createProduct({
        categoryId: data2.categoryId,
        title: data2.title,
        description: data2.description,
        price: data2.price,
        sizes: data2.sizes,
        images: data2.images,
      })
      sessions.delete(adminId)
      await ctx.answerCallbackQuery({ text: 'Saqlandi' })
      await ctx.reply(`✅ <b>${product.title}</b> katalogga qo‘shildi.`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🛍 Katalogni ko‘rish', 'adm:products:0'),
      })
      return
    }
    if (action === 'cancel') {
      sessions.delete(adminId)
      await ctx.answerCallbackQuery({ text: 'Bekor qilindi' })
      return ctx.reply('❌ Mahsulot qo‘shish bekor qilindi.', { reply_markup: panelKeyboard() })
    }
    if (action === 'toggle') {
      const product = getProduct(Number(arg1))
      if (!product) return ctx.answerCallbackQuery({ text: 'Topilmadi' })
      updateProduct(product.id, { active: !product.active })
      const view = productDetailView(product.id)
      await ctx.answerCallbackQuery({ text: product.active ? 'Yashirildi' : 'Faollashtirildi' })
      return ctx.editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard })
    }
    if (action === 'price') {
      sessions.set(adminId, { step: 'editprice', startedAt: Date.now(), data: { productId: Number(arg1) } })
      await ctx.answerCallbackQuery()
      return ctx.reply('Yangi narxni so‘mda yozing:')
    }
    if (action === 'del') {
      await ctx.answerCallbackQuery()
      return ctx.editMessageText('Mahsulotni o‘chirishni tasdiqlaysizmi?', {
        reply_markup: new InlineKeyboard()
          .text('🗑 Ha, o‘chirish', `p:delok:${arg1}`)
          .text('⬅️ Yo‘q', `adm:prod:${arg1}`),
      })
    }
    if (action === 'delok') {
      deleteProduct(Number(arg1))
      await ctx.answerCallbackQuery({ text: 'O‘chirildi' })
      const view = productsView(0)
      return ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard })
    }
    return ctx.answerCallbackQuery()
  } catch (error) {
    console.error('[admin] mahsulot callback xatosi:', error)
    sessions.delete(adminId)
    return ctx.answerCallbackQuery({ text: 'Xatolik: ' + error.message, show_alert: true }).catch(() => {})
  }
}

/* ------------------------- mahsulot qo‘shish ustasi ----------------------- */

export async function adminWizard(ctx, next) {
  const adminId = ctx.from?.id
  if (!adminId || !isAdmin(adminId)) return next()
  const session = sessions.get(adminId)
  if (!session) return next()
  if (session.startedAt && Date.now() - session.startedAt > 30 * 60 * 1000) {
    sessions.delete(adminId)
    return ctx.reply('⏱ Jarayon muddati tugadi. Qaytadan boshlang: /admin')
  }

  const message = ctx.message
  const text = message.text?.trim()

  // Boshqa buyruqlar jarayonni bekor qiladi. Faqat tavsif qadamidagi `/skip` istisno —
  // u tavsifni bo'sh qoldirib davom ettiradi.
  if (text?.startsWith('/') && !(text === '/skip' && session.step === 'description')) {
    sessions.delete(adminId)
    return next()
  }

  try {
    if (session.step === 'confirm') {
      return ctx.reply('Tasdiqlash yoki bekor qilish uchun yuqoridagi tugmalardan foydalaning.')
    }

    if (session.step === 'editprice') {
      const price = parsePrice(text)
      if (!price) return ctx.reply('Narxni faqat raqamda yozing, masalan: 890000')
      const product = updateProduct(session.data.productId, { price })
      sessions.delete(adminId)
      const view = productDetailView(product.id)
      return ctx.reply(`✅ Narx yangilandi: ${money(product.price)}\n\n${view.text}`, {
        parse_mode: 'HTML',
        reply_markup: view.keyboard,
      })
    }

    if (session.step === 'images') {
      if (message.photo) {
        const photo = message.photo[message.photo.length - 1]
        const url = await downloadFile(ctx, photo, '.jpg')
        session.data.images.push(url)
        return ctx.reply(`🖼 ${session.data.images.length} media qabul qilindi. Yana yuboring yoki «Tayyor»ni bosing.`, {
          reply_markup: new InlineKeyboard().text('✅ Tayyor', 'p:imgdone'),
        })
      }
      if (message.video || message.animation) {
        const video = message.video ?? message.animation
        const url = await downloadFile(ctx, video, '.mp4')
        session.data.images.push(url)
        return ctx.reply(`🎬 Video qabul qilindi (jami ${session.data.images.length}). Yana yuboring yoki «Tayyor»ni bosing.`, {
          reply_markup: new InlineKeyboard().text('✅ Tayyor', 'p:imgdone'),
        })
      }
      if (text && /^https?:\/\//i.test(text)) {
        session.data.images.push(text)
        return ctx.reply(`🖼 Havola qo‘shildi (jami ${session.data.images.length}). Yana yuboring yoki «Tayyor»ni bosing.`, {
          reply_markup: new InlineKeyboard().text('✅ Tayyor', 'p:imgdone'),
        })
      }
      return ctx.reply('Rasm yoki video yuboring, yoxud https://... havolasini yozing. Mediasiz davom etish uchun «Tayyor»ni bosing.', {
        reply_markup: new InlineKeyboard().text('✅ Tayyor', 'p:imgdone'),
      })
    }

    if (session.step === 'title') {
      if (!text || text.length < 2) return ctx.reply('Nomni yozing (kamida 2 belgi).')
      session.data.title = text.slice(0, 120)
      session.step = 'category'
      const keyboard = new InlineKeyboard()
      for (const category of categoriesForAdmin()) {
        keyboard.text(category.title, `p:cat:${category.id}`).row()
      }
      return ctx.reply('3/6 — Kategoriyani tanlang:', { reply_markup: keyboard })
    }

    if (session.step === 'price') {
      const price = parsePrice(text)
      if (!price) return ctx.reply('Narxni faqat raqamda yozing, masalan: 1290000')
      session.data.price = price
      session.step = 'sizes'
      return ctx.reply('5/6 — Mavjud o‘lchamlarni yozing, vergul bilan (masalan: S, M, L, XL, XXL).\nO‘lcham kerak bo‘lmasa «-» yuboring.')
    }

    if (session.step === 'sizes') {
      const sizes =
        text === '-' || text.toLowerCase() === 'yo‘q'
          ? []
          : text
              .split(',')
              .map((size) => size.trim().toUpperCase())
              .filter(Boolean)
              .slice(0, 12)
      session.data.sizes = sizes
      session.step = 'description'
      return ctx.reply('6/6 — Qisqa tavsif yozing (matn, material, o‘lchamlar bo‘yicha).\nO‘tkazib yuborish uchun /skip.')
    }

    if (session.step === 'description') {
      session.data.description = text === '/skip' ? '' : (text ?? '').slice(0, 800)
      session.step = 'confirm'
      const preview = [
        '👀 <b>Tekshirib ko‘ring</b>',
        '',
        `<b>${session.data.title}</b>`,
        `💵 ${money(session.data.price)}`,
        `📏 ${session.data.sizes.length ? session.data.sizes.join(', ') : 'o‘lchamsiz'}`,
        session.data.description ? `\n${session.data.description}` : '',
        `\n${mediaLine(session.data.images)}`,
      ]
        .filter(Boolean)
        .join('\n')
      const keyboard = new InlineKeyboard()
        .text('✅ Saqlash', 'p:save')
        .text('❌ Bekor qilish', 'p:cancel')
      // Kanal postidagi kabi barcha rasm/video birga ko'rsatiladi
      const sent = await sendProductMedia(ctx.api, ctx.chat.id, session.data.images, {
        caption: preview,
        replyMarkup: keyboard,
      })
      if (sent.mode !== 'none') return
      return ctx.reply(preview, { parse_mode: 'HTML', reply_markup: keyboard })
    }

    return next()
  } catch (error) {
    console.error('[admin] usta xatosi:', error)
    sessions.delete(adminId)
    return ctx.reply('❌ Xatolik yuz berdi: ' + error.message)
  }
}

/* ------------------------------- ro‘yxatdan o‘tish ------------------------ */

export function registerAdminHandlers(bot) {
  bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return
    sessions.delete(ctx.from.id)
    await ctx.reply(panelText(), { parse_mode: 'HTML', reply_markup: panelKeyboard() })
  })

  bot.command('cancel', (ctx) => {
    if (!isAdmin(ctx.from.id)) return
    sessions.delete(ctx.from.id)
    return ctx.reply('Jarayon bekor qilindi.', { reply_markup: panelKeyboard() })
  })

  bot.on(['message:text', 'message:photo', 'message:video', 'message:animation'], adminWizard)
  bot.callbackQuery(/^adm:/, handleAdminCallback)
  bot.callbackQuery(/^p:/, handleProductCallback)
}
