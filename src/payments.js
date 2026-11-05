import crypto from 'node:crypto'
import { clickReady, config, paymeReady } from './config.js'
import {
  createPaymentTransaction,
  findActivePaymentTransaction,
  getOrder,
  getOrderByCode,
  getPaymentTransaction,
  listPaymentTransactions,
  setOrderPaymentStatus,
  setOrderStatus,
  transitionPaymentTransaction,
} from './db.js'
import { notifyPaymentReceived } from './orders.js'

const md5 = (value) => crypto.createHash('md5').update(value).digest('hex')

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a ?? ''))
  const right = Buffer.from(String(b ?? ''))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

// Click submits so‘mda (ixtiyoriy 2 kasr raqami), Payme esa tiyinda.
// Float taqqoslashdagi yumshoq tolerans kichik summa tafovutlarini o‘tkazib yubormasin.
const clickAmountMatches = (value, orderAmount) => {
  const raw = String(value ?? '')
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return false
  const [whole, fraction = ''] = raw.split('.')
  try {
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) === BigInt(orderAmount) * 100n
  } catch {
    return false
  }
}

// Xabar yuborish javobni kutdirmaydi va xatosi to‘lov javobini buzmaydi.
/**
 * To‘lov qabul qilinganda buyurtma `paid` bo‘ladi va hali tasdiqlanmagan bo‘lsa
 * avtomatik `confirmed`ga o‘tadi — shundan keyin admin faqat yetkazishni boshqaradi.
 */
const markPaid = (orderId) => {
  const paid = setOrderPaymentStatus(orderId, 'paid')
  return paid && paid.status === 'new' ? setOrderStatus(paid.id, 'confirmed') : paid
}

const queueNotify = (notify, order) => {
  Promise.resolve()
    .then(() => notify(order))
    .catch((error) => console.error('[payments] xabar yuborilmadi:', error.message))
}

/* ---------------------------------- Click --------------------------------- */
// https://docs.click.uz/click-api/ — SHOP-API prepare (action=0) / complete (action=1).
// Imzo: md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id
//          [+ merchant_prepare_id complete'da] + amount + action + sign_time)

export function clickSignature(params = {}, { complete = false } = {}) {
  const parts = [params.click_trans_id, params.service_id, config.payments.click.secretKey, params.merchant_trans_id]
  if (complete) parts.push(params.merchant_prepare_id)
  parts.push(params.amount, params.action, params.sign_time)
  return md5(parts.map((part) => String(part ?? '')).join(''))
}

const clickReply = (params, error, errorNote, prepareId = null) => ({
  click_trans_id: params?.click_trans_id ?? null,
  merchant_trans_id: params?.merchant_trans_id ?? null,
  merchant_prepare_id: prepareId,
  merchant_confirm_id: null,
  error,
  error_note: errorNote,
})

function validateClick(params, { complete = false } = {}) {
  if (!clickReady) return { failure: clickReply(params, -2, 'Click sozlanmagan') }
  if (String(params.service_id ?? '') !== config.payments.click.serviceId) {
    return { failure: clickReply(params, -2, 'service_id xato') }
  }
  if (String(params.action ?? '') !== (complete ? '1' : '0')) {
    return { failure: clickReply(params, -3, 'action xato') }
  }
  if (!safeEqual(params.sign_string, clickSignature(params, { complete }))) {
    return { failure: clickReply(params, -1, 'Imzo tekshiruvdan o‘tmadi') }
  }
  const order = getOrderByCode(params.merchant_trans_id)
  if (!order || order.payment !== 'click') {
    return { failure: clickReply(params, -5, 'Buyurtma topilmadi') }
  }
  if (!clickAmountMatches(params.amount, order.total)) {
    return { failure: clickReply(params, -6, 'Summa buyurtmaga mos emas') }
  }
  const externalId = String(params.click_trans_id ?? '')
  if (!externalId) return { failure: clickReply(params, -2, 'click_trans_id yo‘q') }
  return { order, externalId }
}

export function handleClickPrepare(params = {}) {
  const checked = validateClick(params, { complete: false })
  if (checked.failure) return checked.failure
  const { order, externalId } = checked
  if (order.status === 'cancelled' || order.paymentStatus === 'cancelled') {
    return clickReply(params, -5, 'Buyurtma bekor qilingan')
  }
  if (order.paymentStatus === 'paid') return clickReply(params, -4, 'Buyurtma allaqachon to‘langan')

  let transaction = getPaymentTransaction('click', externalId)
  if (transaction && transaction.orderId !== order.id) {
    return clickReply(params, -5, 'Tranzaksiya boshqa buyurtmaga tegishli')
  }
  if (!transaction) {
    const active = findActivePaymentTransaction('click', order.id)
    if (active) return clickReply(params, -4, 'Buyurtma uchun to‘lov jarayoni boshlangan', active.id)
    try {
      transaction = createPaymentTransaction({
        orderId: order.id,
        provider: 'click',
        externalId,
        amount: order.total,
        state: 0,
      })
    } catch (error) {
      if (error.code !== 'ERR_SQLITE_CONSTRAINT_UNIQUE') throw error
      transaction = getPaymentTransaction('click', externalId)
      if (transaction?.orderId === order.id) return clickReply(params, 0, 'Success', transaction.id)
      const active = findActivePaymentTransaction('click', order.id)
      return clickReply(params, -4, 'Buyurtma uchun boshqa to‘lov jarayoni faol', active?.id ?? null)
    }
  }
  return clickReply(params, 0, 'Success', transaction.id)
}

export function handleClickComplete(params = {}, { notify = notifyPaymentReceived } = {}) {
  const checked = validateClick(params, { complete: true })
  if (checked.failure) return checked.failure
  const { order, externalId } = checked

  const transaction = getPaymentTransaction('click', externalId)
  if (!transaction || transaction.orderId !== order.id) {
    return clickReply(params, -9, 'Tranzaksiya topilmadi', Number(params.merchant_prepare_id) || null)
  }

  if (String(params.merchant_prepare_id ?? '') !== String(transaction.id)) {
    return clickReply(params, -9, 'Tayyorlangan tranzaksiya mos emas', transaction.id)
  }
  if (transaction.amount !== order.total) {
    return clickReply(params, -6, 'Tranzaksiya summasi mos emas', transaction.id)
  }

  if (transaction.state === 1) {
    // Jarayon to‘lov yozuvi saqlangan zahoti uzilib qolgan bo‘lsa, provider retry
    // kelganda order holatini tiklaymiz.
    if (order.paymentStatus !== 'paid') queueNotify(notify, markPaid(order.id))
    return clickReply(params, 0, 'Success', transaction.id)
  }
  if (transaction.state < 0) {
    return Number(params.error ?? 0) < 0
      ? clickReply(params, 0, 'To‘lov bekor qilingan', transaction.id)
      : clickReply(params, -9, 'Tranzaksiya bekor qilingan', transaction.id)
  }
  // Bekor qilish faqat hali yakunlanmagan prepare holatidan o‘tsin.
  if (Number(params.error ?? 0) < 0) {
    const cancelled = transitionPaymentTransaction(transaction.id, 0, {
      state: -1,
      cancelTime: Date.now(),
      reason: Number(params.error),
    })
    if (!cancelled.changed && cancelled.transaction?.state === 1) {
      if (cancelled.order?.paymentStatus !== 'paid') queueNotify(notify, markPaid(order.id))
      return clickReply(params, 0, 'To‘lov muvaffaqiyatli yakunlangan', transaction.id)
    }
    return clickReply(params, 0, 'To‘lov bekor qilindi', transaction.id)
  }
  if (order.status === 'cancelled' || order.paymentStatus === 'cancelled') {
    return clickReply(params, -5, 'Buyurtma bekor qilingan', transaction.id)
  }
  if (order.paymentStatus === 'paid') {
    return clickReply(params, -4, 'Buyurtma allaqachon to‘langan', transaction.id)
  }

  const completed = transitionPaymentTransaction(transaction.id, 0, { state: 1, performTime: Date.now() }, 'paid')
  if (completed.changed) {
    queueNotify(notify, completed.order)
  } else if (completed.transaction?.state === 1 && order.paymentStatus !== 'paid') {
    queueNotify(notify, markPaid(order.id))
  } else if (completed.transaction?.state !== 1) {
    return clickReply(params, -9, 'Tranzaksiyani yakunlab bo‘lmadi', transaction.id)
  }
  return clickReply(params, 0, 'Success', transaction.id)
}

/* ---------------------------------- Payme --------------------------------- */
// https://developer.help.paycom.uz/ — JSON-RPC, Basic auth: "Paycom:<PAYME_KEY>".
// Summa tiyinda (so‘m × 100), holatlar: 1 — yaratilgan, 2 — bajarilgan,
// -1 — yaratilgandan keyin bekor qilingan, -2 — bajarilgandan keyin bekor qilingan.

const PAYME_LOGIN = 'Paycom'
const ACCOUNT_FIELD = 'order_id'

const paymeError = (code, message, data) => ({
  error: { code, message, ...(data ? { data } : {}) },
})

export function paymeAuthorized(header) {
  if (!paymeReady) return false
  const expected = `Basic ${Buffer.from(`${PAYME_LOGIN}:${config.payments.payme.key}`).toString('base64')}`
  return safeEqual(header, expected)
}

function findPaymeOrder(params) {
  return getOrderByCode(params?.account?.[ACCOUNT_FIELD])
}

function paymeCheckOrder(order, amount) {
  if (!order || order.payment !== 'payme') return paymeError(-31050, 'Buyurtma topilmadi', ACCOUNT_FIELD)
  if (order.status === 'cancelled' || order.paymentStatus === 'cancelled') {
    return paymeError(-31050, 'Buyurtma bekor qilingan', ACCOUNT_FIELD)
  }
  if (order.paymentStatus === 'paid') return paymeError(-31051, 'Buyurtma allaqachon to‘langan', ACCOUNT_FIELD)
  if (!Number.isFinite(amount) || amount !== order.total * 100) return paymeError(-31051, 'Summa noto‘g‘ri', 'amount')
  return null
}

const paymeTransactionResult = (transaction) => ({
  transaction: String(transaction.id),
  create_time: transaction.createTime,
  perform_time: transaction.performTime,
  cancel_time: transaction.cancelTime,
  state: transaction.state,
  reason: transaction.reason,
})

export function handlePayme(payload = {}, authHeader = '', { notify = notifyPaymentReceived } = {}) {
  if (!paymeAuthorized(authHeader)) return paymeError(-32504, 'Ruxsat yo‘q')
  const method = String(payload.method ?? '')
  const params = payload.params ?? {}
  const externalId = String(params.id ?? '')

  if (method === 'CheckPerformTransaction') {
    const order = findPaymeOrder(params)
    const problem = paymeCheckOrder(order, Number(params.amount))
    return problem ?? { result: { allow: true } }
  }

  if (method === 'CreateTransaction') {
    if (!/^[A-Za-z0-9_-]{24}$/.test(externalId)) return paymeError(-31005, 'Tranzaksiya ID noto‘g‘ri')
    const requestedAmount = Number(params.amount)
    const requestedTime = Number(params.time)
    if (!Number.isSafeInteger(requestedAmount) || requestedAmount <= 0) return paymeError(-31001, 'Summa noto‘g‘ri')
    if (!Number.isSafeInteger(requestedTime) || requestedTime <= 0 || requestedTime > Date.now() + 5 * 60 * 1000) {
      return paymeError(-31008, 'Tranzaksiya vaqti noto‘g‘ri')
    }
    const existing = getPaymentTransaction('payme', externalId)
    if (existing) {
      const existingOrder = getOrder(existing.orderId)
      if (!existingOrder || existingOrder.code !== String(params?.account?.[ACCOUNT_FIELD] ?? '')) {
        return paymeError(-31050, 'Tranzaksiya boshqa buyurtmaga tegishli', ACCOUNT_FIELD)
      }
      if (requestedAmount !== existing.amount * 100 || requestedTime !== existing.createTime) {
        return paymeError(-31008, 'Tranzaksiya parametrlari avvalgi so‘rovga mos emas')
      }
      return { result: paymeTransactionResult(existing) }
    }

    if (Date.now() - requestedTime > 12 * 60 * 60 * 1000) {
      return paymeError(-31008, 'Tranzaksiya muddati tugagan')
    }

    const order = findPaymeOrder(params)
    const problem = paymeCheckOrder(order, requestedAmount)
    if (problem) return problem
    if (findActivePaymentTransaction('payme', order.id)) {
      return paymeError(-31008, 'Buyurtma bo‘yicha faol tranzaksiya mavjud')
    }

    let transaction
    try {
      transaction = createPaymentTransaction({
        orderId: order.id,
        provider: 'payme',
        externalId,
        amount: order.total,
        state: 1,
        createTime: requestedTime,
      })
    } catch (error) {
      if (error.code !== 'ERR_SQLITE_CONSTRAINT_UNIQUE') throw error
      const sameId = getPaymentTransaction('payme', externalId)
      if (sameId) {
        const sameOrder = getOrder(sameId.orderId)
        if (
          sameOrder?.code === String(params?.account?.[ACCOUNT_FIELD] ?? '') &&
          requestedAmount === sameId.amount * 100 &&
          requestedTime === sameId.createTime
        ) return { result: paymeTransactionResult(sameId) }
      }
      return paymeError(-31008, 'Buyurtma bo‘yicha faol tranzaksiya mavjud')
    }
    return { result: paymeTransactionResult(transaction) }
  }

  if (method === 'PerformTransaction') {
    const transaction = getPaymentTransaction('payme', externalId)
    if (!transaction) return paymeError(-31003, 'Tranzaksiya topilmadi')
    if (transaction.state !== 1 && transaction.state !== 2) return paymeError(-31008, 'Tranzaksiyani bajarib bo‘lmaydi')

    const order = getOrder(transaction.orderId)
    if (!order || order.payment !== 'payme' || order.total !== transaction.amount) {
      return paymeError(-31008, 'Tranzaksiya buyurtma ma’lumotlariga mos emas')
    }
    if (order.status === 'cancelled' || order.paymentStatus === 'cancelled') {
      return paymeError(-31008, 'Buyurtma bekor qilingan')
    }

    if (transaction.state === 2) {
      if (order.paymentStatus !== 'paid') queueNotify(notify, markPaid(order.id))
      return { result: paymeTransactionResult(transaction) }
    }

    const completed = transitionPaymentTransaction(transaction.id, 1, { state: 2, performTime: Date.now() }, 'paid')
    if (completed.changed || completed.transaction?.state === 2) {
      if (completed.changed) queueNotify(notify, completed.order)
      else if (order.paymentStatus !== 'paid') queueNotify(notify, markPaid(order.id))
      return { result: paymeTransactionResult(completed.transaction) }
    }
    return paymeError(-31008, 'Tranzaksiyani bajarib bo‘lmadi')
  }

  if (method === 'CancelTransaction') {
    const transaction = getPaymentTransaction('payme', externalId)
    if (!transaction) return paymeError(-31003, 'Tranzaksiya topilmadi')
    if (transaction.state < 0) {
      setOrderPaymentStatus(transaction.orderId, 'cancelled')
      return { result: paymeTransactionResult(transaction) }
    }

    const cancelled = transitionPaymentTransaction(transaction.id, transaction.state, {
      state: transaction.state === 2 ? -2 : -1,
      cancelTime: Date.now(),
      reason: Number(params.reason) || 0,
    }, 'cancelled')
    return { result: paymeTransactionResult(cancelled.transaction) }
  }

  if (method === 'CheckTransaction') {
    const transaction = getPaymentTransaction('payme', externalId)
    if (!transaction) return paymeError(-31003, 'Tranzaksiya topilmadi')
    return { result: paymeTransactionResult(transaction) }
  }

  if (method === 'GetStatement') {
    const transactions = listPaymentTransactions('payme', params.from, params.to)
    return {
      result: {
        transactions: transactions.map((transaction) => ({
          id: transaction.externalId,
          time: transaction.createTime,
          amount: transaction.amount * 100,
          account: { [ACCOUNT_FIELD]: transaction.orderCode },
          ...paymeTransactionResult(transaction),
        })),
      },
    }
  }

  return paymeError(-32601, 'Metod topilmadi')
}
