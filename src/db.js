import { DatabaseSync } from 'node:sqlite'
import { config } from './config.js'

export const db = new DatabaseSync(config.dbFile)

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY,
    username    TEXT,
    first_name  TEXT,
    last_name   TEXT,
    phone       TEXT,
    lat         REAL,
    lon         REAL,
    location_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT
  );

  CREATE TABLE IF NOT EXISTS categories (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    slug   TEXT UNIQUE NOT NULL,
    title  TEXT NOT NULL,
    sort   INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    title       TEXT NOT NULL,
    description TEXT,
    price       INTEGER NOT NULL,
    old_price   INTEGER,
    sizes       TEXT NOT NULL DEFAULT '[]',
    images      TEXT NOT NULL DEFAULT '[]',
    badge       TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    sort        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT UNIQUE NOT NULL,
    user_id      INTEGER NOT NULL,
    customer_name TEXT NOT NULL,
    phone        TEXT NOT NULL,
    delivery     TEXT NOT NULL,
    address      TEXT,
    lat          REAL,
    lon          REAL,
    payment      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'new',
    items_total  INTEGER NOT NULL,
    delivery_fee INTEGER NOT NULL DEFAULT 0,
    total        INTEGER NOT NULL,
    comment      TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER,
    title      TEXT NOT NULL,
    size       TEXT,
    price      INTEGER NOT NULL,
    qty        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payment_transactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    provider     TEXT NOT NULL,
    external_id  TEXT NOT NULL,
    state        INTEGER NOT NULL DEFAULT 0,
    amount       INTEGER NOT NULL,
    create_time  INTEGER NOT NULL DEFAULT 0,
    perform_time INTEGER NOT NULL DEFAULT 0,
    cancel_time  INTEGER NOT NULL DEFAULT 0,
    reason       INTEGER,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (provider, external_id)
  );

  CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category_id);
  CREATE INDEX IF NOT EXISTS idx_payments_order ON payment_transactions(order_id);
`)

// Eski bazalarda ustun yo‘q — ma’lumotni yo‘qotmasdan qo‘shamiz.
const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map((row) => row.name)
if (!orderColumns.includes('payment_status')) {
  db.exec("ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'pending'")
}

const parseJson = (value, fallback) => {
  try {
    return JSON.parse(value ?? '')
  } catch {
    return fallback
  }
}

const mapProduct = (row) => {
  if (!row) return null
  return {
    id: row.id,
    categoryId: row.category_id,
    categorySlug: row.category_slug ?? null,
    title: row.title,
    description: row.description ?? '',
    price: row.price,
    oldPrice: row.old_price ?? null,
    sizes: parseJson(row.sizes, []),
    images: parseJson(row.images, []),
    badge: row.badge ?? null,
    active: Number(row.active) === 1,
    sort: row.sort,
    createdAt: row.created_at,
  }
}

const mapOrder = (row) => {
  if (!row) return null
  return {
    id: row.id,
    code: row.code,
    userId: row.user_id,
    username: row.user_username ?? null,
    customerName: row.customer_name,
    phone: row.phone,
    delivery: row.delivery,
    address: row.address ?? '',
    lat: row.lat ?? null,
    lon: row.lon ?? null,
    payment: row.payment,
    paymentStatus: row.payment_status ?? 'pending',
    status: row.status,
    itemsTotal: row.items_total,
    deliveryFee: row.delivery_fee,
    total: row.total,
    comment: row.comment ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/* ---------------------------------- users --------------------------------- */

export function upsertUser(user) {
  if (!user?.id) return null
  db.prepare(
    `INSERT INTO users (id, username, first_name, last_name, last_seen_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       last_seen_at = datetime('now')`,
  ).run(Number(user.id), user.username ?? null, user.first_name ?? null, user.last_name ?? null)
  return getUser(user.id)
}

export function getUser(id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id))
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    lat: row.lat,
    lon: row.lon,
  }
}

export function setUserPhone(id, phone) {
  db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, Number(id))
}

export function setUserLocation(id, lat, lon) {
  db.prepare("UPDATE users SET lat = ?, lon = ?, location_at = datetime('now') WHERE id = ?").run(
    Number(lat),
    Number(lon),
    Number(id),
  )
}

/* -------------------------------- catalog --------------------------------- */

export function listCategories() {
  return db
    .prepare('SELECT * FROM categories WHERE active = 1 ORDER BY sort, id')
    .all()
    .map((row) => ({ id: row.id, slug: row.slug, title: row.title }))
}

export function listProducts({ categorySlug = null, includeInactive = false } = {}) {
  const rows = db
    .prepare(
      `SELECT p.*, c.slug AS category_slug
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE (? = 1 OR p.active = 1)
         AND (? IS NULL OR c.slug = ?)
       ORDER BY p.sort, p.id DESC`,
    )
    .all(includeInactive ? 1 : 0, categorySlug, categorySlug)
  return rows.map(mapProduct)
}

export function getProduct(id) {
  return mapProduct(
    db
      .prepare(
        `SELECT p.*, c.slug AS category_slug
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.id = ?`,
      )
      .get(Number(id)),
  )
}

export function createProduct(product) {
  const result = db
    .prepare(
      `INSERT INTO products (category_id, title, description, price, old_price, sizes, images, badge, active, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      product.categoryId ?? null,
      product.title,
      product.description ?? '',
      product.price,
      product.oldPrice ?? null,
      JSON.stringify(product.sizes ?? []),
      JSON.stringify(product.images ?? []),
      product.badge ?? null,
      product.active === false ? 0 : 1,
      product.sort ?? 0,
    )
  return getProduct(Number(result.lastInsertRowid))
}

export function updateProduct(id, patch) {
  const fields = []
  const values = []
  const set = (column, value) => {
    fields.push(`${column} = ?`)
    values.push(value)
  }
  if (patch.title !== undefined) set('title', patch.title)
  if (patch.description !== undefined) set('description', patch.description)
  if (patch.price !== undefined) set('price', patch.price)
  if (patch.oldPrice !== undefined) set('old_price', patch.oldPrice)
  if (patch.categoryId !== undefined) set('category_id', patch.categoryId)
  if (patch.sizes !== undefined) set('sizes', JSON.stringify(patch.sizes))
  if (patch.images !== undefined) set('images', JSON.stringify(patch.images))
  if (patch.badge !== undefined) set('badge', patch.badge)
  if (patch.active !== undefined) set('active', patch.active ? 1 : 0)
  if (!fields.length) return getProduct(id)
  values.push(Number(id))
  db.prepare(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return getProduct(id)
}

export function deleteProduct(id) {
  db.prepare('DELETE FROM products WHERE id = ?').run(Number(id))
}

/* --------------------------------- orders --------------------------------- */

const formatDate = (date) => date.toISOString().slice(0, 10).replaceAll('-', '').slice(2)

export function createOrder({ user, customerName, phone, delivery, address, lat, lon, payment, items, deliveryFee, comment }) {
  const itemsTotal = items.reduce((sum, item) => sum + item.price * item.qty, 0)
  const total = itemsTotal + deliveryFee
  const dayPrefix = `SU-${formatDate(new Date())}`

  db.exec('BEGIN')
  try {
    const seq =
      db.prepare("SELECT COUNT(*) AS count FROM orders WHERE code LIKE ?").get(`${dayPrefix}-%`).count + 1
    const code = `${dayPrefix}-${String(seq).padStart(3, '0')}`

    const result = db
      .prepare(
        `INSERT INTO orders (code, user_id, customer_name, phone, delivery, address, lat, lon, payment, status,
                             items_total, delivery_fee, total, comment)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)`,
      )
      .run(
        code,
        Number(user.id),
        customerName,
        phone,
        delivery,
        address ?? null,
        lat ?? null,
        lon ?? null,
        payment,
        itemsTotal,
        deliveryFee,
        total,
        comment ?? null,
      )

    const orderId = Number(result.lastInsertRowid)
    const insertItem = db.prepare(
      'INSERT INTO order_items (order_id, product_id, title, size, price, qty) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const item of items) {
      insertItem.run(orderId, item.productId ?? null, item.title, item.size ?? null, item.price, item.qty)
    }

    db.exec('COMMIT')
    return getOrder(orderId)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function getOrder(id) {
  const order = mapOrder(
    db
      .prepare('SELECT o.*, u.username AS user_username FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?')
      .get(Number(id)),
  )
  if (!order) return null
  order.items = db
    .prepare('SELECT id, product_id, title, size, price, qty FROM order_items WHERE order_id = ? ORDER BY id')
    .all(order.id)
    .map((row) => ({
      id: row.id,
      productId: row.product_id,
      title: row.title,
      size: row.size,
      price: row.price,
      qty: row.qty,
    }))
  return order
}

export function listOrders({ status = null, limit = 10, offset = 0 } = {}) {
  const rows = db
    .prepare(
      `SELECT o.*, u.username AS user_username FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       WHERE (? IS NULL OR o.status = ?)
       ORDER BY o.id DESC LIMIT ? OFFSET ?`,
    )
    .all(status, status, limit, offset)
  return rows.map((row) => {
    const order = mapOrder(row)
    order.items = db
      .prepare('SELECT title, size, price, qty FROM order_items WHERE order_id = ? ORDER BY id')
      .all(row.id)
    return order
  })
}

export function countOrders(status = null) {
  return db
    .prepare('SELECT COUNT(*) AS count FROM orders WHERE (? IS NULL OR status = ?)')
    .get(status, status).count
}

export function listUserOrders(userId, limit = 20) {
  const rows = db
    .prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(userId), limit)
  return rows.map((row) => {
    const order = mapOrder(row)
    order.items = db
      .prepare('SELECT title, size, price, qty FROM order_items WHERE order_id = ? ORDER BY id')
      .all(row.id)
    return order
  })
}

export function setOrderStatus(id, status) {
  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, Number(id))
  return getOrder(id)
}

export function getOrderByCode(code) {
  const row = db.prepare('SELECT id FROM orders WHERE code = ?').get(String(code ?? ''))
  return row ? getOrder(row.id) : null
}

export function setOrderPaymentStatus(id, status) {
  db.prepare("UPDATE orders SET payment_status = ?, updated_at = datetime('now') WHERE id = ?").run(
    String(status),
    Number(id),
  )
  return getOrder(id)
}

/* --------------------------- to‘lov tranzaksiyalari ----------------------- */

const mapTransaction = (row) =>
  row
    ? {
        id: row.id,
        orderId: row.order_id,
        provider: row.provider,
        externalId: row.external_id,
        state: row.state,
        amount: row.amount,
        createTime: row.create_time,
        performTime: row.perform_time,
        cancelTime: row.cancel_time,
        reason: row.reason ?? null,
      }
    : null

export function getPaymentTransaction(provider, externalId) {
  return mapTransaction(
    db
      .prepare('SELECT * FROM payment_transactions WHERE provider = ? AND external_id = ?')
      .get(String(provider), String(externalId)),
  )
}

export function createPaymentTransaction({ orderId, provider, externalId, amount, state = 0, createTime = 0 }) {
  const result = db
    .prepare(
      `INSERT INTO payment_transactions (order_id, provider, external_id, state, amount, create_time)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(Number(orderId), String(provider), String(externalId), Number(state), Number(amount), Number(createTime) || 0)
  return mapTransaction(db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(Number(result.lastInsertRowid)))
}

export function updatePaymentTransaction(id, patch = {}) {
  const fields = []
  const values = []
  const set = (column, value) => {
    fields.push(`${column} = ?`)
    values.push(value)
  }
  if (patch.state !== undefined) set('state', Number(patch.state))
  if (patch.createTime !== undefined) set('create_time', Number(patch.createTime) || 0)
  if (patch.performTime !== undefined) set('perform_time', Number(patch.performTime) || 0)
  if (patch.cancelTime !== undefined) set('cancel_time', Number(patch.cancelTime) || 0)
  if (patch.reason !== undefined) set('reason', patch.reason === null ? null : Number(patch.reason))
  if (fields.length) {
    values.push(Number(id))
    db.prepare(`UPDATE payment_transactions SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
      ...values,
    )
  }
  return mapTransaction(db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(Number(id)))
}

export function findActivePaymentTransaction(provider, orderId) {
  return mapTransaction(
    db
      .prepare('SELECT * FROM payment_transactions WHERE provider = ? AND order_id = ? AND state > 0 ORDER BY id DESC')
      .get(String(provider), Number(orderId)),
  )
}

export function listPaymentTransactions(provider, from, to) {
  return db
    .prepare(
      `SELECT t.*, o.code AS order_code FROM payment_transactions t
       JOIN orders o ON o.id = t.order_id
       WHERE t.provider = ? AND t.create_time >= ? AND t.create_time <= ?
       ORDER BY t.id`,
    )
    .all(String(provider), Number(from) || 0, Number(to) || Date.now())
    .map((row) => ({ ...mapTransaction(row), orderCode: row.order_code }))
}

export function stats() {
  const today = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
       FROM orders WHERE date(created_at) = date('now') AND status != 'cancelled'`,
    )
    .get()
  const week = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
       FROM orders WHERE created_at >= datetime('now', '-7 days') AND status != 'cancelled'`,
    )
    .get()
  const all = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
       FROM orders WHERE status != 'cancelled'`,
    )
    .get()
  const newCount = countOrders('new')
  const users = db.prepare('SELECT COUNT(*) AS count FROM users').get().count
  const products = db.prepare('SELECT COUNT(*) AS count FROM products WHERE active = 1').get().count
  return {
    today: { orders: today.orders, revenue: today.revenue },
    week: { orders: week.orders, revenue: week.revenue },
    all: { orders: all.orders, revenue: all.revenue },
    newOrders: newCount,
    users,
    products,
  }
}

export function categoriesForAdmin() {
  return db.prepare('SELECT * FROM categories ORDER BY sort, id').all()
}

export function ensureCategory(slug, title, sort = 0) {
  const existing = db.prepare('SELECT * FROM categories WHERE slug = ?').get(slug)
  if (existing) return existing
  const result = db
    .prepare('INSERT INTO categories (slug, title, sort) VALUES (?, ?, ?)')
    .run(slug, title, sort)
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(result.lastInsertRowid))
}
