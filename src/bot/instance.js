import { Bot } from 'grammy'
import { config } from '../config.js'

if (!config.botToken) {
  throw new Error('BOT_TOKEN topilmadi. .env faylini tekshiring.')
}

export const bot = new Bot(config.botToken)

export const isAdmin = (userId) => config.adminIds.includes(Number(userId))
