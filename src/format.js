export const money = (value) =>
  `${new Intl.NumberFormat('ru-RU').format(Math.round(Number(value) || 0)).replace(/\u00A0/g, ' ')} so‘m`

export const dateTime = (value) => {
  if (!value) return '—'
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('uz-UZ', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tashkent',
  }).format(date)
}

export const STATUS_LABELS = {
  new: '🆕 Yangi',
  confirmed: '✅ Tasdiqlandi',
  shipping: '🚚 Kuryerda',
  delivered: '📦 Yetkazildi',
  cancelled: '❌ Bekor qilindi',
}

export const PAYMENT_LABELS = {
  click: 'Click (onlayn)',
  payme: 'Payme (onlayn)',
  cash: 'Naqd / karta — yetkazib berishda',
}

export const DELIVERY_LABELS = {
  courier: 'Kuryer orqali manzilga',
  pickup: 'Do‘kondan olib ketish',
}

export const statusLabel = (status) => STATUS_LABELS[status] ?? status
