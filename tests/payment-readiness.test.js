import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standart-payment-readiness-'))
process.env.DB_FILE = path.join(tmpDir, 'test.db')
process.env.BOT_TOKEN = '123456:TEST_TOKEN'
process.env.CLICK_SERVICE_ID = ''
process.env.CLICK_MERCHANT_ID = ''
process.env.CLICK_SECRET_KEY = ''
process.env.CLICK_CALLBACK_IPS = ''
process.env.PAYME_MERCHANT_ID = ''
process.env.PAYME_KEY = ''
process.env.PAYME_CALLBACK_IPS = ''

const { placeOrder, OrderError } = await import('../src/orders.js')
const { clickReady, paymeReady } = await import('../src/config.js')
const user = { id: 700002 }
const payload = (payment) => ({
  items: [{ productId: 1, qty: 1 }],
  customerName: 'Test Mijoz',
  phone: '+998901112233',
  delivery: 'pickup',
  payment,
})
const productLookup = (id) => ({ id, active: true, price: 100000, sizes: [] })

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

test('callback IP ro‘yxatisiz online to‘lovlar o‘chiq va server buyurtmani rad etadi', () => {
  assert.equal(clickReady, false)
  assert.equal(paymeReady, false)
  assert.throws(() => placeOrder(user, payload('click'), productLookup), OrderError)
  assert.throws(() => placeOrder(user, payload('payme'), productLookup), OrderError)
})
