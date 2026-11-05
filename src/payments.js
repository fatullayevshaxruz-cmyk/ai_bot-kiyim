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
  updatePaymentTransaction,
} from './db.js'
import { notifyPaymentReceived } from './orders.js'

const md5 = (value) => crypto.createHash('md5').update(value).digest('hex')

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a ?? ''))
  const right = Buffer.from(String(b ?? ''))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
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
  const amount = Number(params.amount)
  if (!Number.isFinite(amount) || Math.abs(amount - order.total) >= 1) {
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
  if (order.paymentStatus === 'paid') return clickReply(params, -4, 'Buyurtma allaqachon to‘langan')

  let transaction = getPaymentTransaction('click', externalId)
  if (transaction && transaction.orderId !== order.id) {
    return clickReply(params, -5, 'Tranzaksiya boshqa buyurtmaga tegishli')
  }
  if (!transaction) {
    transaction = createPaymentTransaction({
      orderId: order.id,
      provider: 'click',
      externalId,
      amount: order.total,
      state: 0,
    })
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

  // Click to‘lovni bekor qilgan bo‘lsa (error < 0) tranzaksiyani yopamiz.
  if (Number(params.error ?? 0) < 0) {
    updatePaymentTransaction(transaction.id, { state: -1, cancelTime: Date.now(), reason: Number(params.error) })
    return clickReply(params, 0, 'To‘lov bekor qilindi', transaction.id)
  }

  if (transaction.state === 1) {
    return clickReply(params, 0, 'Success', transaction.id)
  }

  updatePaymentTransaction(transaction.id, { state: 1, performTime: Date.now() })
  queueNotify(notify, markPaid(order.id))
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
  if (order.status === 'cancelled') return paymeError(-31050, 'Buyurtma bekor qilingan', ACCOUNT_FIELD)
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
    if (!externalId) return paymeError(-31005, 'Tranzaksiya ID yo‘q')
    const existing = getPaymentTransaction('payme', externalId)
    if (existing) {
      const existingOrder = getOrder(existing.orderId)
      if (!existingOrder || existingOrder.code !== String(params?.account?.[ACCOUNT_FIELD] ?? '')) {
        return paymeError(-31050, 'Tranzaksiya boshqa buyurtmaga tegishli', ACCOUNT_FIELD)
      }
      return { result: paymeTransactionResult(existing) }
    }

    const order = findPaymeOrder(params)
    const problem = paymeCheckOrder(order, Number(params.amount))
    if (problem) return problem
    if (findActivePaymentTransaction('payme', order.id)) {
      return paymeError(-31008, 'Buyurtma bo‘yicha faol tranzaksiya mavjud')
    }

    const transaction = createPaymentTransaction({
      orderId: order.id,
      provider: 'payme',
      externalId,
      amount: order.total,
      state: 1,
      createTime: Number(params.time) || Date.now(),
    })
    return { result: paymeTransactionResult(transaction) }
  }

  if (method === 'PerformTransaction') {
    const transaction = getPaymentTransaction('payme', externalId)
    if (!transaction) return paymeError(-31003, 'Tranzaksiya topilmadi')
    if (transaction.state === 2) return { result: paymeTransactionResult(transaction) }
    if (transaction.state !== 1) return paymeError(-31008, 'Tranzaksiyani bajarib bo‘lmaydi')

    const performed = updatePaymentTransaction(transaction.id, { state: 2, performTime: Date.now() })
    queueNotify(notify, markPaid(performed.orderId))
    return { result: paymeTransactionResult(performed) }
  }

  if (method === 'CancelTransaction') {
    const transaction = getPaymentTransaction('payme', externalId)
    if (!transaction) return paymeError(-31003, 'Tranzaksiya topilmadi')
    if (transaction.state < 0) return { result: paymeTransactionResult(transaction) }

    const cancelled = updatePaymentTransaction(transaction.id, {
      state: transaction.state === 2 ? -2 : -1,
      cancelTime: Date.now(),
      reason: Number(params.reason) || 0,
    })
    setOrderPaymentStatus(cancelled.orderId, 'cancelled')
    return { result: paymeTransactionResult(cancelled) }
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
