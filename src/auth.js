import crypto from 'node:crypto'

/**
 * Telegram Web App initData tekshiruvi.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(initData, botToken, { maxAgeSeconds = 86400 } = {}) {
  if (!initData || !botToken) return null
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return null

  params.delete('hash')
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest()
  const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

  if (calculated.length !== hash.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(hash))) return null

  const authDate = Number(params.get('auth_date') ?? 0)
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > maxAgeSeconds) return null

  let user = null
  try {
    user = JSON.parse(params.get('user') ?? 'null')
  } catch {
    return null
  }
  if (!user?.id) return null
  return user
}

/** Test uchun initData yasash (productionda ishlatilmaydi). */
export function signInitData(user, botToken, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: `AA${Math.random().toString(36).slice(2, 12)}`,
    user: JSON.stringify(user),
  })
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest()
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  params.set('hash', hash)
  return params.toString()
}
