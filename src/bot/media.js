import fs from 'node:fs'
import path from 'node:path'
import { InputFile } from 'grammy'
import { config } from '../config.js'

/**
 * Mahsulot medialarini Telegram'ga yuborish.
 *
 * Kanal postidagi kabi: mahsulotda bir nechta rasm va video bo'lishi mumkin.
 * Bot API albumda 10 tadan ko'p elementni qabul qilmaydi, shuning uchun
 * 10+ media bir nechta albomga bo'linadi. Caption faqat birinchi elementga
 * qo'shiladi — Telegram albom ostida bitta matn ko'rsatadi.
 */

const VIDEO_RE = /\.(mp4|mov|webm|m4v)(\?|#|$)/i
const ALBUM_LIMIT = 10
const MAX_UPLOAD_MB = 50

export const isVideoMedia = (src) => VIDEO_RE.test(String(src ?? ''))

export const mediaSummary = (images = []) => {
  const list = (images ?? []).filter(Boolean)
  const videos = list.filter(isVideoMedia).length
  return { photos: list.length - videos, videos }
}

const isRemote = (src) => /^https?:\/\//i.test(src)

/**
 * Media manbasini Telegram tushunadigan ko'rinishga keltiradi:
 *  - https://...  → o'zgarishsiz (Telegram o'zi yuklab oladi)
 *  - /uploads/x   → PUBLIC_URL bo'lsa to'liq havola, bo'lmasa lokal fayl
 * Fayl topilmasa yoki yo'l xavfli bo'lsa `null`.
 */
export function resolveMedia(src, publicUrl = config.publicUrl) {
  if (!src || typeof src !== 'string') return null
  if (isRemote(src)) return { media: src }
  if (!src.startsWith('/')) return null

  if (/^https:\/\//i.test(publicUrl ?? '')) return { media: `${publicUrl}${src}` }

  const relative = src.replace(/^\/uploads\/?/, '')
  const filePath = path.resolve(config.uploadsDir, relative)
  // `..` orqali uploads papkasidan chiqib ketishning oldini olamiz
  if (!filePath.startsWith(path.resolve(config.uploadsDir) + path.sep)) return null
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size > MAX_UPLOAD_MB * 1024 * 1024) return null
  return { media: new InputFile(filePath, path.basename(filePath)) }
}

/**
 * Media ro'yxatidan Telegram albomlarini tayyorlaydi.
 * @returns {Array<Array<{type: 'photo'|'video', media: string|InputFile, caption?: string}>>}
 */
export function buildAlbums(images = [], { publicUrl = config.publicUrl, caption = '' } = {}) {
  const items = []
  for (const src of images ?? []) {
    const resolved = resolveMedia(src, publicUrl)
    if (!resolved) continue
    items.push({ type: isVideoMedia(src) ? 'video' : 'photo', media: resolved.media })
  }
  if (!items.length) return []
  if (caption) {
    items[0].caption = caption
    items[0].parse_mode = 'HTML'
  }
  const albums = []
  for (let index = 0; index < items.length; index += ALBUM_LIMIT) {
    albums.push(items.slice(index, index + ALBUM_LIMIT))
  }
  return albums
}

/**
 * Mahsulot medialarini yuboradi. Media bo'lmasa yoki yuborib bo'lmasa
 * matnli xabar bilan qaytadi — foydalanuvchi hech qachon bo'sh javob olmaydi.
 *
 * @returns {Promise<{mode: 'album'|'photo'|'video'|'text'|'none'}>}
 */
export async function sendProductMedia(api, chatId, images, { caption = '', replyMarkup, publicUrl } = {}) {
  const albums = buildAlbums(images, { publicUrl, caption })
  if (!albums.length) return { mode: 'none' }

  const [first, ...rest] = albums
  const extra = { reply_markup: replyMarkup }
  try {
    if (first.length === 1) {
      const item = first[0]
      const options = { caption: caption || undefined, parse_mode: 'HTML', ...extra }
      if (item.type === 'video') await api.sendVideo(chatId, item.media, options)
      else await api.sendPhoto(chatId, item.media, options)
      return { mode: item.type === 'video' ? 'video' : 'photo' }
    }
    await api.sendMediaGroup(chatId, first, extra)
    for (const album of rest) await api.sendMediaGroup(chatId, album)
    return { mode: 'album' }
  } catch (error) {
    // Eng ko'p uchraydigan sabab: PUBLIC_URL yo'q yoki Telegram faylni ololmadi
    console.error('[media] yuborishda xatolik:', error.message)
    if (!caption) return { mode: 'none' }
    await api.sendMessage(chatId, caption, { parse_mode: 'HTML', ...extra }).catch((sendError) => {
      console.error('[media] matnli xabar ham yuborilmadi:', sendError.message)
    })
    return { mode: 'text' }
  }
}
