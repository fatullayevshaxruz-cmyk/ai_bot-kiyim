import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from '../src/config.js'
import { adminWizard, sessions } from '../src/bot/admin.js'

// Admin panelidagi tasdiqlash qadami kanal postidagi barcha media'ni ko'rsatishi kerak.
// Telegram kerak emas: ctx.api o'rniga yozib oluvchi obyekt beriladi.
const adminId = config.adminIds[0]
const skip = adminId ? false : 'ADMIN_IDS sozlanmagan'

function fakeContext(api, text = 'Tavsif') {
  return {
    from: { id: adminId },
    chat: { id: adminId },
    message: { text },
    api,
    reply: async (payload) => ({ recorded: payload }),
  }
}

function startSession(data) {
  sessions.set(adminId, {
    step: 'description',
    startedAt: Date.now(),
    data: { images: [], title: 'Klassik kostyum «Atlas»', categoryId: 1, price: 1890000, sizes: ['M', 'L'], description: '', ...data },
  })
}

test('tasdiqlashda rasm va video birga albom bo‘lib ketadi', { skip }, async () => {
  const groups = []
  const api = {
    async sendMediaGroup(chatId, media) {
      groups.push(media)
      return {}
    },
    async sendMessage() {
      throw new Error('albom yuborilganda matn chaqirilmasligi kerak')
    },
  }
  startSession({ images: ['https://cdn.example/a.jpg', 'https://cdn.example/b.mp4'] })
  await adminWizard(fakeContext(api), () => {})

  assert.equal(sessions.get(adminId).step, 'confirm')
  assert.equal(groups.length, 1)
  assert.equal(groups[0].length, 2)
  assert.equal(groups[0][0].type, 'photo')
  assert.equal(groups[0][1].type, 'video')
  assert.match(groups[0][0].caption, /Klassik kostyum/)
  assert.match(groups[0][0].caption, /Video: 1 ta/)
  sessions.delete(adminId)
})

test('bitta video mahsulot sendVideo bilan yuboriladi', { skip }, async () => {
  const videos = []
  const api = {
    async sendVideo(chatId, media, options) {
      videos.push({ media, options })
      return {}
    },
  }
  startSession({ images: ['https://cdn.example/reel.mp4'] })
  await adminWizard(fakeContext(api), () => {})

  assert.equal(videos.length, 1)
  assert.equal(videos[0].media, 'https://cdn.example/reel.mp4')
  assert.match(videos[0].options.caption, /1 890 000/)
  sessions.delete(adminId)
})

test('mediasiz mahsulot matn bilan tasdiqlanadi', { skip }, async () => {
  const groups = []
  let replies = 0
  const api = {
    async sendMediaGroup() {
      groups.push(1)
    },
  }
  const ctx = fakeContext(api)
  ctx.reply = async (payload) => {
    replies += 1
    return payload
  }
  startSession({ images: [] })
  await adminWizard(ctx, () => {})

  assert.equal(groups.length, 0)
  assert.equal(replies, 1)
  sessions.delete(adminId)
})
