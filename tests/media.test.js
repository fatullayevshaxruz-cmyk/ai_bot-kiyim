import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { config } from '../src/config.js'
import { buildAlbums, isVideoMedia, mediaSummary, resolveMedia, sendProductMedia } from '../src/bot/media.js'

test('video kengaytmalari aniqlanadi', () => {
  assert.equal(isVideoMedia('/uploads/tg-1-2-1.mp4'), true)
  assert.equal(isVideoMedia('/uploads/tg-1-2-1.MP4'), true)
  assert.equal(isVideoMedia('https://cdn.example/a.mov?x=1'), true)
  assert.equal(isVideoMedia('/uploads/a.jpg'), false)
  assert.equal(isVideoMedia(null), false)
})

test('media statistikasi rasm va videoni ajratadi', () => {
  assert.deepEqual(mediaSummary(['/a.jpg', '/b.mp4', '/c.webm', 'https://x/d.png']), { photos: 2, videos: 2 })
  assert.deepEqual(mediaSummary([]), { photos: 0, videos: 0 })
})

test('albom 10 tadan bo‘linadi, caption faqat birinchisida', () => {
  const images = Array.from({ length: 12 }, (_, index) => `https://cdn.example/${index}.jpg`)
  const albums = buildAlbums(images, { publicUrl: '', caption: 'Mahsulot' })
  assert.equal(albums.length, 2)
  assert.equal(albums[0].length, 10)
  assert.equal(albums[1].length, 2)
  assert.equal(albums[0][0].caption, 'Mahsulot')
  assert.equal(albums[1][0].caption, undefined)
  assert.equal(albums[0][0].type, 'photo')
})

test('PUBLIC_URL bo‘lsa nisbiy yo‘l to‘liq havolaga aylanadi', () => {
  const albums = buildAlbums(['/uploads/a.jpg', '/uploads/b.mp4'], { publicUrl: 'https://shop.example' })
  assert.equal(albums[0][0].media, 'https://shop.example/uploads/a.jpg')
  assert.equal(albums[0][1].media, 'https://shop.example/uploads/b.mp4')
  assert.equal(albums[0][1].type, 'video')
})

test('PUBLIC_URL bo‘lmasa lokal fayl ishlatiladi', () => {
  const name = `test-media-${Date.now()}.jpg`
  const filePath = path.join(config.uploadsDir, name)
  fs.writeFileSync(filePath, Buffer.from('test'))
  try {
    const resolved = resolveMedia(`/uploads/${name}`, '')
    assert.ok(resolved, 'lokal fayl topilishi kerak')
    assert.notEqual(typeof resolved.media, 'string')
  } finally {
    fs.rmSync(filePath, { force: true })
  }
  assert.equal(resolveMedia(`/uploads/${name}`, ''), null, 'fayl yo‘q bo‘lsa null')
})

test('uploads papkasidan tashqariga chiqish bloklanadi', () => {
  assert.equal(resolveMedia('/uploads/../../etc/passwd', ''), null)
  assert.equal(resolveMedia('javascript:alert(1)', ''), null)
})

test('media yuborilmasa matnli xabar bilan qaytadi', async () => {
  const calls = []
  const api = {
    async sendMediaGroup() {
      throw new Error('Telegram faylni ololmadi')
    },
    async sendMessage(chatId, text, options) {
      calls.push({ chatId, text, options })
      return {}
    },
  }
  const result = await sendProductMedia(api, 42, ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'], {
    caption: 'Katalog kartochkasi',
  })
  assert.equal(result.mode, 'text')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].text, 'Katalog kartochkasi')
})

test('media yo‘q bo‘lsa hech narsa yuborilmaydi', async () => {
  const api = { async sendMessage() { throw new Error('chaqirilmasligi kerak') } }
  assert.equal((await sendProductMedia(api, 1, [])).mode, 'none')
})
