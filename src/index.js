import { config, assertConfig, isPublicUrlReady } from './config.js'
import { createBot } from './bot/index.js'
import { createServer } from './server.js'

const problems = assertConfig()
if (problems.length) {
  console.warn('[boot] Diqqat:')
  for (const problem of problems) console.warn('  •', problem)
}

const bot = createBot()
const app = createServer()

// Host ko‘rsatilmaydi: Node dual-stack (IPv4 + IPv6) tinglaydi — tunnel va localhost uchun muhim
const server = app.listen(config.port, () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : config.port
  console.log(`[web] Web App: http://localhost:${port}`)
  if (port !== config.port) console.warn(`[web] Diqqat: ${config.port} porti band bo‘lmagani uchun ${port} ishlatilmoqda`)
})

try {
  await bot.init()
  console.log(`[bot] @${bot.botInfo.username} sifatida ishga tushmoqda`)

  await bot.api.setMyCommands([
    { command: 'start', description: '🛍 Katalogni ochish' },
    { command: 'orders', description: '📦 Buyurtmalarim' },
    { command: 'support', description: '📞 Operator bilan bog‘lanish' },
    { command: 'admin', description: '⚙️ Admin panel' },
  ])

  if (isPublicUrlReady) {
    await bot.api
      .setChatMenuButton({
        menu_button: { type: 'web_app', text: '🛍 Katalog', web_app: { url: config.publicUrl } },
      })
      .catch((error) => console.warn('[bot] menu tugmasi o‘rnatilmadi:', error.message))
  }

  await bot.api
    .deleteWebhook({ drop_pending_updates: false })
    .catch(() => {})
} catch (error) {
  console.error('[bot] ishga tushmadi:', error.message)
  console.error('Token yoki tarmoqni tekshiring. Bot polling bilan ishlaydi.')
  process.exitCode = 1
  server.close()
  process.exit(1)
}

server.on('error', (error) => {
  console.error('[web] server xatosi:', error.message)
  process.exit(1)
})

const shutdown = async (signal) => {
  console.log(`\n[bot] ${signal} — to‘xtatilmoqda...`)
  await bot.stop().catch(() => {})
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000)
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

await bot.start({
  allowed_updates: ['message', 'callback_query'],
  onStart: (info) => console.log(`[bot] @${info.username} polling boshlandi ✅`),
})
