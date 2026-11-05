import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// To‘lov callback’lari vaqtinchalik bazada, tarmoqsiz tekshiriladi.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standart-payments-'))
process.env.DB_FILE = path.join(tmpDir, 'test.db')
process.env.CLICK_SERVICE_ID = '1111'
process.env.CLICK_MERCHANT_ID = '2222'
process.env.CLICK_SECRET_KEY = 'click-secret'
process.env.PAYME_MERCHANT_ID = 'payme-merchant'
process.env.PAYME_KEY = 'payme-key'

const { clickSignature, handleClickComplete, handleClickPrepare, handlePayme } = await import('../src/payments.js')
const { createOrder, getOrderByCode, getPaymentTransaction, upsertUser } = await import('../src/db.js')

const user = upsertUser({ id: 700001, first_name: 'Test', last_name: 'Mijoz' })

function makeOrder(payment) {
  return createOrder({
    user,
    customerName: 'Test Mijoz',
    phone: '+998901112233',
    delivery: 'pickup',
    address: '',
    lat: null,
    lon: null,
    payment,
    items: [{ productId: null, title: 'Kostyum', size: 'M', price: 120000, qty: 2 }],
    deliveryFee: 0,
    comment: '',
  })
}

let clickSequence = 0
function signedClick(order, overrides = {}, { complete = false } = {}) {
  clickSequence += 1
  const params = {
    click_trans_id: `click-${Date.now()}-${clickSequence}`,
    service_id: '1111',
    merchant_trans_id: order.code,
    amount: `${order.total}.00`,
    action: complete ? '1' : '0',
    sign_time: '2026-11-04 12:00:00',
    error: '0',
    ...overrides,
  }
  return { ...params, sign_string: clickSignature(params, { complete }) }
}

const paymeAuth = `Basic ${Buffer.from('Paycom:payme-key').toString('base64')}`
const paymeCall = (method, params, header = paymeAuth) =>
  handlePayme({ id: 1, method, params }, header, { notify: async () => {} })

test.after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // vaqtinchalik papka o‘chmasa ham test natijasiga ta’sir qilmaydi
  }
})

test('Click prepare imzo, service_id va summani tekshiradi', () => {
  const order = makeOrder('click')
  const params = signedClick(order)
  const response = handleClickPrepare(params)

  assert.equal(response.error, 0)
  assert.ok(response.merchant_prepare_id)
  assert.equal(getPaymentTransaction('click', params.click_trans_id).state, 0)

  assert.equal(handleClickPrepare({ ...params, sign_string: 'deadbeef' }).error, -1)
  assert.equal(handleClickPrepare({ ...params, service_id: '9999' }).error, -2)
  assert.equal(handleClickPrepare(signedClick(order, { amount: '1.00' })).error, -6)
  assert.equal(handleClickPrepare(signedClick(order, { merchant_trans_id: 'SU-XX-000' })).error, -5)
})

test('Click complete buyurtmani to‘langan deb belgilaydi va idempotent', async () => {
  const order = makeOrder('click')
  const prepareParams = signedClick(order)
  const prepared = handleClickPrepare(prepareParams)

  const completeParams = signedClick(
    order,
    {
      click_trans_id: prepareParams.click_trans_id,
      merchant_prepare_id: String(prepared.merchant_prepare_id),
    },
    { complete: true },
  )

  const notified = []
  const response = handleClickComplete(completeParams, {
    notify: async (paid) => {
      notified.push(paid)
    },
  })
  assert.equal(response.error, 0)
  assert.equal(response.merchant_prepare_id, prepared.merchant_prepare_id)

  const paidOrder = getOrderByCode(order.code)
  assert.equal(paidOrder.paymentStatus, 'paid')
  // To‘lovdan keyin buyurtma avtomatik tasdiqlanadi.
  assert.equal(paidOrder.status, 'confirmed')
  assert.equal(getPaymentTransaction('click', prepareParams.click_trans_id).state, 1)

  // Takroriy complete (retry) xato qaytarmaydi va ikkinchi marta xabar yubormaydi.
  const repeated = handleClickComplete(completeParams, { notify: async (paid) => notified.push(paid) })
  assert.equal(repeated.error, 0)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(notified.length, 1)
  assert.equal(notified[0].code, order.code)
})

test('Click complete error < 0 bo‘lsa tranzaksiyani bekor qiladi', () => {
  const order = makeOrder('click')
  const prepareParams = signedClick(order)
  const prepared = handleClickPrepare(prepareParams)
  const completeParams = signedClick(
    order,
    {
      click_trans_id: prepareParams.click_trans_id,
      merchant_prepare_id: String(prepared.merchant_prepare_id),
      error: '-1',
    },
    { complete: true },
  )

  const response = handleClickComplete(completeParams)
  assert.equal(response.error, 0)
  assert.equal(getPaymentTransaction('click', prepareParams.click_trans_id).state, -1)
  assert.equal(getOrderByCode(order.code).paymentStatus, 'pending')
})

test('Payme faqat to‘g‘ri Basic auth bilan ishlaydi', () => {
  const order = makeOrder('payme')
  const params = { amount: order.total * 100, account: { order_id: order.code } }

  assert.equal(paymeCall('CheckPerformTransaction', params, 'Basic noto‘g‘ri').error.code, -32504)
  assert.deepEqual(paymeCall('CheckPerformTransaction', params), { result: { allow: true } })
  assert.equal(paymeCall('CheckPerformTransaction', { ...params, amount: 1 }).error.code, -31051)
  assert.equal(
    paymeCall('CheckPerformTransaction', { ...params, account: { order_id: 'SU-XX-000' } }).error.code,
    -31050,
  )
  assert.equal(paymeCall('UnknownMethod', {}).error.code, -32601)
})

test('Payme create → perform → cancel oqimi va idempotentlik', async () => {
  const order = makeOrder('payme')
  const createParams = {
    id: `payme-${Date.now()}`,
    time: Date.now(),
    amount: order.total * 100,
    account: { order_id: order.code },
  }

  const created = paymeCall('CreateTransaction', createParams)
  assert.equal(created.result.state, 1)
  assert.equal(paymeCall('CreateTransaction', createParams).result.transaction, created.result.transaction)

  const performed = paymeCall('PerformTransaction', { id: createParams.id })
  assert.equal(performed.result.state, 2)
  assert.equal(getOrderByCode(order.code).paymentStatus, 'paid')
  assert.equal(getOrderByCode(order.code).status, 'confirmed')

  const repeated = paymeCall('PerformTransaction', { id: createParams.id })
  assert.equal(repeated.result.perform_time, performed.result.perform_time)

  const checked = paymeCall('CheckTransaction', { id: createParams.id })
  assert.equal(checked.result.state, 2)

  const cancelled = paymeCall('CancelTransaction', { id: createParams.id, reason: 5 })
  assert.equal(cancelled.result.state, -2)
  assert.equal(getOrderByCode(order.code).paymentStatus, 'cancelled')

  const statement = paymeCall('GetStatement', { from: 0, to: Date.now() + 1000 })
  assert.ok(statement.result.transactions.some((item) => item.id === createParams.id))
})
