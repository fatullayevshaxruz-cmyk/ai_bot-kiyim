import { bot } from './instance.js'
import { registerAdminHandlers } from './admin.js'
import { registerUserHandlers } from './user.js'

export function createBot() {
  // Admin ustasi matnli xabarlarni birinchi ushlaydi, qolganlari foydalanuvchi oqimiga o'tadi
  registerAdminHandlers(bot)
  registerUserHandlers(bot)

  bot.catch((error) => {
    console.error('[bot] xatosi:', error.error?.message ?? error)
  })

  return bot
}
