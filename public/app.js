/* Standart Uzbekistan — Telegram Mini App */
const tg = window.Telegram?.WebApp ?? null
if (tg) {
  try {
    tg.ready()
    tg.expand()
    tg.setHeaderColor('#0b0b0c')
    tg.setBackgroundColor('#0b0b0c')
  } catch {
    /* eski Telegram versiyalari */
  }
}

const CART_KEY = 'su_cart_v1'
const STATUS_LABELS = {
  new: 'Yangi',
  confirmed: 'Tasdiqlandi',
  shipping: 'Kuryerda',
  delivered: 'Yetkazildi',
  cancelled: 'Bekor qilindi',
}
const STORE_CATEGORIES = [
  { slug: 'outerwear', title: 'Ustki kiyim' },
  { slug: 'suits', title: 'Kostyumlar' },
  { slug: 'knitwear', title: 'Sviter va hudilar' },
  { slug: 'tops', title: 'Ko‘ylak va futbolkalar' },
  { slug: 'bottoms', title: 'Shim va jinsilar' },
  { slug: 'shoes', title: 'Oyoq kiyim' },
  { slug: 'accessories', title: 'Aksessuarlar' },
]

const state = {
  view: 'catalog',
  categories: [],
  products: [],
  settings: { deliveryFee: 0, freeDeliveryFrom: 0, store: {}, support: {}, payments: {} },
  user: null,
  category: 'all',
  search: '',
  productId: null,
  size: null,
  qty: 1,
  cart: loadCart(),
  step: 1,
  orders: [],
  ordersError: '',
  ordersLoading: false,
  success: null,
  submitting: false,
  errors: {},
  form: { name: '', phone: '', delivery: 'courier', address: '', payment: '', comment: '', lat: null, lon: null },
}

const el = (id) => document.getElementById(id)
const views = {
  catalog: el('viewCatalog'),
  cart: el('viewCart'),
  checkout: el('viewCheckout'),
  orders: el('viewOrders'),
  success: el('viewSuccess'),
}

/* --------------------------------- utils --------------------------------- */

const money = (value) =>
  `${new Intl.NumberFormat('ru-RU').format(Math.round(Number(value) || 0)).replace(/\u00A0/g, ' ')} so‘m`

const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const normalizePhone = (raw) => {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (digits.length === 9 && digits.startsWith('9')) return `+998${digits}`
  if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`
  return null
}

function haptic(type = 'light') {
  try {
    tg?.HapticFeedback?.impactOccurred(type)
  } catch {
    /* ignore */
  }
}

let toastTimer = null
function toast(message) {
  const node = el('toast')
  node.textContent = message
  node.classList.add('is-visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), 2400)
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {}
  if (tg?.initData) headers['X-Init-Data'] = tg.initData
  if (body) headers['Content-Type'] = 'application/json'
  const response = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok) {
    const error = new Error(data?.message || 'Xatolik yuz berdi')
    error.status = response.status
    throw error
  }
  return data
}

const findProduct = (id) => state.products.find((product) => product.id === Number(id))
const VIDEO_RE = /\.(mp4|mov|webm|m4v)(\?|$)/i
const isVideo = (src) => VIDEO_RE.test(String(src ?? ''))
// Kartochka va savatchada rasm ishlatiladi; video bo'lsa poster yoki birinchi rasm.
const productImage = (product) => product?.images?.find((src) => src && !isVideo(src)) ?? ''

/* --------------------------------- cart ---------------------------------- */

function loadCart() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CART_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveCart() {
  localStorage.setItem(CART_KEY, JSON.stringify(state.cart))
  updateBadges()
}

const cartKey = (productId, size) => `${productId}:${size ?? ''}`

function cartLines() {
  const lines = []
  for (const item of state.cart) {
    const product = findProduct(item.productId)
    if (!product) continue
    lines.push({
      key: cartKey(item.productId, item.size),
      productId: item.productId,
      size: item.size ?? null,
      qty: item.qty,
      product,
      sum: product.price * item.qty,
    })
  }
  return lines
}

function cartTotals() {
  const lines = cartLines()
  const count = lines.reduce((sum, line) => sum + line.qty, 0)
  const itemsTotal = lines.reduce((sum, line) => sum + line.sum, 0)
  const freeFrom = Number(state.settings.freeDeliveryFrom) || 0
  const freeDelivery = freeFrom > 0 && itemsTotal >= freeFrom
  const deliveryFee = state.form.delivery === 'pickup' || freeDelivery ? 0 : Number(state.settings.deliveryFee) || 0
  return { lines, count, itemsTotal, deliveryFee, total: itemsTotal + deliveryFee, freeDelivery, freeFrom }
}

function addToCart(product, size, qty) {
  if (product.sizes.length && !size) {
    toast('O‘lchamni tanlang')
    return false
  }
  const key = cartKey(product.id, size)
  const existing = state.cart.find((item) => cartKey(item.productId, item.size) === key)
  if (existing) existing.qty = Math.min(existing.qty + qty, 10)
  else state.cart.push({ productId: product.id, size: size ?? null, qty })
  saveCart()
  haptic('medium')
  return true
}

function updateBadges() {
  const count = cartLines().reduce((sum, line) => sum + line.qty, 0)
  for (const node of [el('cartCount'), el('tabCartCount')]) {
    if (!node) continue
    node.textContent = String(count)
    node.classList.toggle('hidden', count === 0)
  }
}

/* -------------------------------- routing -------------------------------- */

function go(view) {
  state.view = view
  if (view === 'orders') loadOrders()
  render()
  window.scrollTo(0, 0)
  syncBackButton()
}

function syncBackButton() {
  if (!tg?.BackButton) return
  if (state.view === 'catalog') tg.BackButton.hide()
  else tg.BackButton.show()
}

/* -------------------------------- render --------------------------------- */

function render() {
  for (const [name, node] of Object.entries(views)) {
    node.classList.toggle('hidden', name !== state.view)
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.nav === state.view)
  }
  if (state.view === 'catalog') renderCatalog()
  if (state.view === 'cart') renderCart()
  if (state.view === 'checkout') renderCheckout()
  if (state.view === 'orders') renderOrders()
  if (state.view === 'success') renderSuccess()
  updateBadges()
}

function renderCatalog() {
  const chips = [{ slug: 'all', title: 'Barchasi' }, ...STORE_CATEGORIES]
  el('chips').innerHTML = chips
    .map(
      (category) =>
        `<button type="button" class="chip ${state.category === category.slug ? 'is-active' : ''}" data-category="${escapeHtml(
          category.slug,
        )}">${escapeHtml(category.title)}</button>`,
    )
    .join('')

  const products =
    state.category === 'all'
      ? state.products
      : state.products.filter((product) => productCategory(product) === state.category)
  const filtered = products.filter((product) => `${product.title} ${product.description ?? ''}`.toLocaleLowerCase().includes(state.search.toLocaleLowerCase()))

  el('catalogEmpty').classList.toggle('hidden', filtered.length > 0)
  el('grid').innerHTML = filtered.map(productCard).join('')
  renderStories()
}

function productCategory(product) {
  const title = `${product.title ?? ''} ${product.description ?? ''}`.toLocaleLowerCase()
  if (/(tufli|poyabzal|oyoq kiyim|shoe|sneaker|loafer|oxford)/i.test(title)) return 'shoes'
  if (/(kostyum|suit|smoking|pidjak)/i.test(title)) return 'suits'
  if (/(shim|şim|jins|jean|pants|chino)/i.test(title)) return 'bottoms'
  if (/(sviter|sweater|kardigan|poluzamok|xudi|hudi|hoodie)/i.test(title)) return 'knitwear'
  if (/(ko.{0,2}ylak|futbolka|shirt|t-shirt|tee)/i.test(title)) return 'tops'
  if (/(aksessuar|kamar|galstuk|sumka|chemodan|çemodan|soat|belt|tie)/i.test(title)) return 'accessories'
  if (/(vetrovka|kurtka|palto|coat|jacket|nimcha|outerwear)/i.test(title)) return 'outerwear'
  const known = STORE_CATEGORIES.find((category) => category.slug === product.categorySlug)
  return known?.slug ?? 'outerwear'
}

function renderStories() {
  const host = el('stories')
  if (!host) return
  const products = state.products.slice(0, 8)
  host.innerHTML = products.map((product, index) => `<button class="story-card" data-product="${product.id}" type="button"><span class="story-card__image">${productImage(product) ? `<img src="${escapeHtml(productImage(product))}" alt=""/>` : ''}<i>${String(index + 1).padStart(2, '0')}</i></span><span>${escapeHtml(product.title)}</span></button>`).join('')
}

function productCard(product) {
  const image = productImage(product)
  const sizes = product.sizes.length ? product.sizes.join(' · ') : 'Bir o‘lcham'
  return `<article class="card" data-product="${product.id}">
    <div class="card__media">
      ${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(product.title)}" loading="lazy" />` : ''}
      ${product.badge ? `<span class="card__badge">${escapeHtml(product.badge)}</span>` : ''}
    </div>
    <div class="card__body">
      <h3 class="card__title">${escapeHtml(product.title)}</h3>
      <div class="card__price">
        <span>${money(product.price)}</span>
        ${product.oldPrice ? `<s>${money(product.oldPrice)}</s>` : ''}
      </div>
      <div class="card__sizes">${escapeHtml(sizes)}</div>
    </div>
  </article>`
}

function renderCart() {
  const { lines, count, itemsTotal, deliveryFee, total, freeDelivery, freeFrom } = cartTotals()
  if (!lines.length) {
    views.cart.innerHTML = `<h2 class="view__title">Savatcham</h2>
      <div class="empty">
        <div class="empty__title">Savatcha bo‘sh</div>
        Katalogdan o‘zingizga mos model va o‘lchamni tanlang.
        <div style="margin-top:18px"><button class="btn btn--primary btn--small" data-nav="catalog">🛍 Katalogga o‘tish</button></div>
      </div>`
    return
  }

  const items = lines
    .map(
      (line) => `<article class="cart-item">
      <div class="cart-item__media">${productImage(line.product) ? `<img src="${escapeHtml(productImage(line.product))}" alt="" />` : ''}</div>
      <div class="cart-item__body">
        <h3 class="cart-item__title">${escapeHtml(line.product.title)}</h3>
        <div class="cart-item__meta">${line.size ? `O‘lcham: <b>${escapeHtml(line.size)}</b>` : 'Bir o‘lcham'}</div>
        <div class="cart-item__foot">
          <span class="cart-item__price">${money(line.sum)}</span>
          <div class="qty">
            <button type="button" data-action="qty" data-key="${escapeHtml(line.key)}" data-dir="-1">−</button>
            <span>${line.qty}</span>
            <button type="button" data-action="qty" data-key="${escapeHtml(line.key)}" data-dir="1">+</button>
          </div>
        </div>
      </div>
      <button type="button" class="cart-item__remove" data-action="remove" data-key="${escapeHtml(line.key)}" aria-label="O‘chirish">✕</button>
    </article>`,
    )
    .join('')

  const freeNote =
    freeFrom > 0 && !freeDelivery
      ? `<div class="note">🚚 Yana ${money(freeFrom - itemsTotal)} xarid qilsangiz — yetkazish bepul.</div>`
      : freeDelivery
        ? '<div class="note">🎁 Yetkazish bepul — buyurtmangiz uchun rahmat!</div>'
        : ''

  views.cart.innerHTML = `<h2 class="view__title">Savatcham</h2>
    <p class="view__subtitle">${count} mahsulot · ${money(itemsTotal)}</p>
    <div class="cart-list">${items}</div>
    ${freeNote}
    <div class="summary">
      <div class="summary__row"><span>Mahsulotlar</span><span>${money(itemsTotal)}</span></div>
      <div class="summary__row"><span>Yetkazish</span><span>${deliveryFee ? money(deliveryFee) : 'Tanlanadi'}</span></div>
      <div class="summary__row summary__row--total"><span>Jami</span><strong>${money(total)}</strong></div>
    </div>
    <button class="btn btn--primary" data-action="checkout">Rasmiylashtirish →</button>`
}

function err(key) {
  return state.errors[key] ? `<div class="field__error">${escapeHtml(state.errors[key])}</div>` : ''
}

function renderCheckout() {
  const { lines, itemsTotal, deliveryFee, total } = cartTotals()
  if (!lines.length) {
    go('cart')
    return
  }
  const step = state.step
  const labels = ['Aloqa', 'Yetkazish', 'To‘lov', 'Tasdiq']
  const stepper = labels
    .map(
      (label, index) =>
        `<div class="stepper__item ${index + 1 === step ? 'is-active' : ''} ${index + 1 < step ? 'is-done' : ''}">
          <span>${index + 1 < step ? '✓' : index + 1}</span><em>${label}</em>
        </div>`,
    )
    .join('')

  let content = ''
  if (step === 1) {
    const f = state.form
    content = `<section class="panel">
      <h2 class="panel__title">Ma’lumotlaringiz</h2>
      <p class="panel__hint">Buyurtma bo‘yicha siz bilan shu raqam orqali bog‘lanamiz.</p>
      <label class="field ${state.errors.name ? 'is-error' : ''}">
        <span>Ism va familiya</span>
        <input data-field="name" value="${escapeHtml(f.name)}" placeholder="Masalan: Aziza Karimova" autocomplete="name" />
      </label>${err('name')}
      <label class="field ${state.errors.phone ? 'is-error' : ''}">
        <span>Telefon raqam</span>
        <input data-field="phone" value="${escapeHtml(f.phone)}" placeholder="+998 90 123 45 67" inputmode="tel" autocomplete="tel" />
      </label>${err('phone')}
      <button type="button" class="btn btn--ghost" data-action="share-contact">📱 Telegram kontaktini ulashish</button>
      <p class="panel__hint" style="margin:10px 0 0">Raqam botga yuboriladi va avtomatik to‘ldiriladi. Bo‘lmasa qo‘lda yozing.</p>
    </section>`
  }

  if (step === 2) {
    const f = state.form
    const fee = Number(state.settings.deliveryFee) || 0
    const freeFrom = Number(state.settings.freeDeliveryFrom) || 0
    const courierHint = freeFrom > 0 && itemsTotal >= freeFrom ? 'Bepul yetkazish' : `${money(fee)} · Toshkent bo‘ylab 1 kunda`
    content = `<section class="panel">
      <h2 class="panel__title">Yetkazib berish</h2>
      <p class="panel__hint">Qulay usulni tanlang.</p>
      <div class="option ${f.delivery === 'courier' ? 'is-active' : ''}" data-action="select-delivery" data-value="courier">
        <span class="option__icon">🚚</span>
        <span class="option__body"><strong>Kuryer orqali</strong><small>${courierHint}</small></span>
        <span class="option__check"></span>
      </div>
      <div class="option ${f.delivery === 'pickup' ? 'is-active' : ''}" data-action="select-delivery" data-value="pickup">
        <span class="option__icon">🏬</span>
        <span class="option__body"><strong>Do‘kondan olib ketish</strong><small>Bepul · ${escapeHtml(state.settings.store?.address ?? '')}</small></span>
        <span class="option__check"></span>
      </div>
      ${
        f.delivery === 'courier'
          ? `<label class="field ${state.errors.address ? 'is-error' : ''}" style="margin-top:14px">
              <span>Manzil</span>
              <textarea data-field="address" placeholder="Tuman, ko‘cha, uy, xonadon">${escapeHtml(f.address)}</textarea>
            </label>${err('address')}
            <button type="button" class="btn btn--ghost" data-action="share-location">
              📍 Lokatsiyani yuborish ${f.lat && f.lon ? '· ✅' : ''}
            </button>
            <p class="panel__hint" style="margin:10px 0 0">Lokatsiya yuborilsa, manzilni yozish shart emas.</p>`
          : `<div class="note" style="margin-top:14px">🏬 ${escapeHtml(state.settings.store?.address ?? '')}${
              state.settings.store?.landmark ? `<br />${escapeHtml(state.settings.store.landmark)}` : ''
            }</div>`
      }
    </section>`
  }

  if (step === 3) {
    const f = state.form
    const payments = state.settings.payments ?? {}
    content = `<section class="panel">
      <h2 class="panel__title">To‘lov usuli</h2>
      <p class="panel__hint">Onlayn to‘lov havolasi buyurtma tasdiqlangach yuboriladi.</p>
      <div class="option ${f.payment === 'click' ? 'is-active' : ''}" data-action="select-payment" data-value="click">
        <span class="option__icon">💳</span>
        <span class="option__body"><strong>Click</strong><small>${payments.click ? 'Onlayn to‘lov · darhol tasdiqlanadi' : 'Havola menejer tomonidan yuboriladi'}</small></span>
        <span class="option__check"></span>
      </div>
      <div class="option ${f.payment === 'payme' ? 'is-active' : ''}" data-action="select-payment" data-value="payme">
        <span class="option__icon">💳</span>
        <span class="option__body"><strong>Payme</strong><small>${payments.payme ? 'Onlayn to‘lov · darhol tasdiqlanadi' : 'Havola menejer tomonidan yuboriladi'}</small></span>
        <span class="option__check"></span>
      </div>
      <div class="option ${f.payment === 'cash' ? 'is-active' : ''}" data-action="select-payment" data-value="cash">
        <span class="option__icon">💵</span>
        <span class="option__body"><strong>Yetkazib berishda</strong><small>Naqd yoki karta orqali kuryerga to‘lash</small></span>
        <span class="option__check"></span>
      </div>
      ${err('payment')}
    </section>`
  }

  if (step === 4) {
    const f = state.form
    const deliveryText =
      f.delivery === 'courier' ? `Kuryer · ${escapeHtml(f.address || 'lokatsiya bo‘yicha')}` : 'Do‘kondan olib ketish'
    const paymentText = { click: 'Click (onlayn)', payme: 'Payme (onlayn)', cash: 'Yetkazib berishda to‘lash' }[f.payment]
    content = `<section class="panel">
      <h2 class="panel__title">Buyurtmani tasdiqlang</h2>
      <p class="panel__hint">Barchasi to‘g‘rimi? Tasdiqlagandan so‘ng menejer bog‘lanadi.</p>
      ${lines
        .map(
          (line) =>
            `<div class="recap-item"><span>${escapeHtml(line.product.title)}${line.size ? ` · ${escapeHtml(line.size)}` : ''} × ${line.qty}</span><strong>${money(line.sum)}</strong></div>`,
        )
        .join('')}
      <div class="summary" style="margin-top:14px">
        <div class="summary__row"><span>Mahsulotlar</span><span>${money(itemsTotal)}</span></div>
        <div class="summary__row"><span>Yetkazish</span><span>${deliveryFee ? money(deliveryFee) : 'Bepul'}</span></div>
        <div class="summary__row summary__row--total"><span>Jami</span><strong>${money(total)}</strong></div>
      </div>
      <div class="recap-item"><span>👤 Mijoz</span><strong>${escapeHtml(f.name)} · ${escapeHtml(f.phone)}</strong></div>
      <div class="recap-item"><span>📍 Yetkazish</span><strong>${deliveryText}</strong></div>
      <div class="recap-item"><span>💳 To‘lov</span><strong>${escapeHtml(paymentText ?? '—')}</strong></div>
      <label class="field" style="margin-top:14px">
        <span>Izoh (ixtiyoriy)</span>
        <textarea data-field="comment" placeholder="Masalan: 18:00 dan keyin qo‘ng‘iroq qiling">${escapeHtml(f.comment)}</textarea>
      </label>
    </section>`
  }

  const ctaLabel =
    step === 4 ? (state.submitting ? 'Yuborilmoqda...' : 'Buyurtmani tasdiqlash') : 'Davom etish →'

  views.checkout.innerHTML = `<button class="link-back" data-nav="cart">← Savatcha</button>
    <div class="stepper">${stepper}</div>
    ${content}
    <div class="sticky-cta">
      <div class="summary__row summary__row--total" style="padding:0 2px 10px">
        <span>Jami</span><strong>${money(total)}</strong>
      </div>
      <button class="btn btn--primary" data-action="step-next" ${state.submitting ? 'disabled' : ''}>${ctaLabel}</button>
      ${step > 1 ? `<button class="btn btn--ghost" data-action="step-back" style="margin-top:8px">← Orqaga</button>` : ''}
    </div>`
}

function renderOrders() {
  if (state.ordersLoading) {
    views.orders.innerHTML = '<div class="empty">Yuklanmoqda…</div>'
    return
  }
  if (state.ordersError) {
    views.orders.innerHTML = `<h2 class="view__title">Buyurtmalarim</h2>
      <div class="notice">${escapeHtml(state.ordersError)}</div>
      ${
        state.settings.botUrl
          ? `<button class="btn btn--primary" data-action="open-bot" data-url="${escapeHtml(state.settings.botUrl)}">Telegram botda ochish</button>`
          : ''
      }
      <button class="btn btn--ghost" data-action="refresh-orders" style="margin-top:8px">🔄 Qayta urinish</button>`
    return
  }
  if (!state.orders.length) {
    views.orders.innerHTML = `<h2 class="view__title">Buyurtmalarim</h2>
      <div class="empty"><div class="empty__title">Hozircha buyurtma yo‘q</div>Katalogdan birinchi xaridingizni boshlang.</div>
      <button class="btn btn--primary" data-nav="catalog">🛍 Katalogga o‘tish</button>`
    return
  }
  views.orders.innerHTML = `<h2 class="view__title">Buyurtmalarim</h2>
    <p class="view__subtitle">Holat o‘zgarganda bot sizga xabar yuboradi.</p>
    ${state.orders
      .map(
        (order) => `<article class="order-card">
          <div class="order-card__head">
            <span class="order-card__code">${escapeHtml(order.code)}</span>
            <span class="status status--${escapeHtml(order.status)}">${escapeHtml(STATUS_LABELS[order.status] ?? order.status)}</span>
          </div>
          <div class="order-card__items">
            ${order.items
              .map(
                (item) =>
                  `${escapeHtml(item.title)}${item.size ? ` · ${escapeHtml(item.size)}` : ''} × ${item.qty}`,
              )
              .join('<br />')}
          </div>
          <div class="order-card__foot">
            <span class="muted">${escapeHtml(order.delivery === 'pickup' ? 'Do‘kondan olib ketish' : 'Kuryer')}${order.paymentStatus === 'paid' ? ' · ✅ to‘langan' : ''}</span>
            <span class="order-card__total">${money(order.total)}</span>
          </div>
        </article>`,
      )
      .join('')}
    <button class="btn btn--ghost" data-action="refresh-orders">🔄 Yangilash</button>`
}

function renderSuccess() {
  const order = state.success
  if (!order) {
    views.success.innerHTML = ''
    return
  }
  views.success.innerHTML = `<div class="success">
    <div class="success__icon">✓</div>
    <h1 class="success__title">Buyurtma qabul qilindi</h1>
    <p class="success__code">${escapeHtml(order.code)}</p>
    <p class="muted" style="font-size:13.5px;line-height:1.6">Menejerimiz tez orada bog‘lanadi.<br />Holatni «Buyurtmalarim» bo‘limida kuzatishingiz mumkin.</p>
    <div class="summary" style="text-align:left;margin-top:20px">
      <div class="summary__row"><span>Mahsulotlar</span><span>${money(order.itemsTotal)}</span></div>
      <div class="summary__row"><span>Yetkazish</span><span>${order.deliveryFee ? money(order.deliveryFee) : 'Bepul'}</span></div>
      <div class="summary__row summary__row--total"><span>Jami</span><strong>${money(order.total)}</strong></div>
    </div>
    ${
      order.paymentUrl
        ? `<a class="btn btn--primary" href="${escapeHtml(order.paymentUrl)}" target="_blank" rel="noopener">💳 To‘lovni amalga oshirish</a>`
        : ''
    }
    ${
      order.payment && order.payment !== 'cash' && !order.paymentUrl
        ? `<div class="note" style="margin-top:14px;text-align:left">💳 Onlayn to‘lov havolasini menejerimiz shu buyurtma raqami bilan yuboradi.</div>`
        : ''
    }
    <div class="success__actions">
      <button class="btn btn--ghost" data-nav="orders">📦 Buyurtmalarim</button>
      <button class="btn btn--ghost" data-nav="catalog">🛍 Katalogga qaytish</button>
    </div>
  </div>`
}

/* -------------------------------- product sheet -------------------------- */

function openProduct(productId) {
  const product = findProduct(productId)
  if (!product) return
  state.productId = product.id
  state.size = product.sizes.length === 1 ? product.sizes[0] : null
  state.qty = 1
  renderSheet()
  const sheet = el('sheet')
  sheet.classList.add('is-open')
  sheet.setAttribute('aria-hidden', 'false')
  document.body.style.overflow = 'hidden'
}

function closeSheet() {
  el('sheet').classList.remove('is-open')
  el('sheet').setAttribute('aria-hidden', 'true')
  document.body.style.overflow = ''
}

function renderSheet() {
  const product = findProduct(state.productId)
  if (!product) return
  const images = product.images.length ? product.images : ['']
  el('sheetPanel').innerHTML = `
    <button type="button" class="sheet__close" data-action="close-sheet" aria-label="Yopish">✕</button>
    <div class="gallery">${images
      .map((src) => {
        if (!src) return ''
        // Videolar Instagram storiya ko‘rinishida (vertikal, progress bilan) chiqadi.
        return isVideo(src)
          ? `<figure class="story" data-action="story-toggle" role="button" tabindex="0" aria-label="Videoni ijro etish">
               <span class="story__track"><i></i></span>
               <video src="${escapeHtml(src)}" playsinline controls preload="metadata" loop muted></video>
               <span class="story__badge">STORIYA</span>
               <span class="story__hint">▶ Bosib ko‘rish</span>
             </figure>`
          : `<img src="${escapeHtml(src)}" alt="${escapeHtml(product.title)}" />`
      })
      .join('')}</div>
    <div class="sheet__content">
      <h2 class="sheet__title">${escapeHtml(product.title)}</h2>
      <div class="sheet__price">
        <span>${money(product.price)}</span>
        ${product.oldPrice ? `<s>${money(product.oldPrice)}</s>` : ''}
      </div>
      ${product.description ? `<p class="sheet__desc">${escapeHtml(product.description)}</p>` : ''}
      ${
        product.sizes.length
          ? `<div class="size-block__head"><span>O‘lcham</span><span class="size-block__hint" id="sizeHint">${
              state.size ? `Tanlandi: ${escapeHtml(state.size)}` : 'Tanlang'
            }</span></div>
             <div class="sizes">${product.sizes
               .map(
                 (size) =>
                   `<button type="button" class="size ${state.size === size ? 'is-active' : ''}" data-size="${escapeHtml(size)}">${escapeHtml(size)}</button>`,
               )
               .join('')}</div>`
          : `<div class="size-block__head"><span>O‘lcham</span><span class="size-block__hint">Bir o‘lcham</span></div>`
      }
      <div class="qty-row">
        <span class="qty-row__label">Soni</span>
        <div class="qty">
          <button type="button" data-action="sheet-qty" data-dir="-1">−</button>
          <span>${state.qty}</span>
          <button type="button" data-action="sheet-qty" data-dir="1">+</button>
        </div>
      </div>
      <button class="btn btn--primary" data-action="add-to-cart">Savatchaga qo‘shish · ${money(product.price * state.qty)}</button>
    </div>`
}

/* --------------------------------- actions -------------------------------- */

async function loadOrders() {
  state.ordersLoading = true
  state.ordersError = ''
  renderOrders()
  try {
    const data = await api('/api/orders')
    state.orders = data.orders ?? []
  } catch (error) {
    state.orders = []
    state.ordersError =
      error.status === 401
        ? 'Buyurtmalarni ko‘rish uchun ilovani Telegram bot orqali oching.'
        : error.message
  } finally {
    state.ordersLoading = false
    if (state.view === 'orders') renderOrders()
  }
}

async function refreshMe() {
  try {
    const data = await api('/api/me')
    if (!data.user) return
    if (data.user.phone) state.form.phone = data.user.phone
    if (data.user.lat && data.user.lon) {
      state.form.lat = data.user.lat
      state.form.lon = data.user.lon
    }
    if (!state.form.name || state.form.name === 'Mijoz') state.form.name = data.user.name ?? state.form.name
    if (state.view === 'checkout') renderCheckout()
    return data.user
  } catch {
    return null
  }
}

function validateStep(step) {
  const f = state.form
  const errors = {}
  if (step === 1) {
    if (f.name.trim().length < 2) errors.name = 'Ismingizni kiriting'
    if (!normalizePhone(f.phone)) errors.phone = 'Format: +998 90 123 45 67'
  }
  if (step === 2) {
    if (f.delivery === 'courier' && f.address.trim().length < 5 && !(f.lat && f.lon)) {
      errors.address = 'Manzilni kiriting yoki lokatsiya yuboring'
    }
  }
  if (step === 3 && !f.payment) {
    errors.payment = 'To‘lov usulini tanlang'
  }
  state.errors = errors
  return Object.keys(errors).length === 0
}

async function submitOrder() {
  if (state.submitting) return
  for (const step of [1, 2, 3]) {
    if (!validateStep(step)) {
      state.step = step
      render()
      return
    }
  }
  state.submitting = true
  render()
  try {
    const { lines } = cartTotals()
    const data = await api('/api/orders', {
      method: 'POST',
      body: {
        items: lines.map((line) => ({ productId: line.productId, size: line.size, qty: line.qty })),
        customerName: state.form.name.trim(),
        phone: normalizePhone(state.form.phone),
        delivery: state.form.delivery,
        address: state.form.address.trim(),
        lat: state.form.lat,
        lon: state.form.lon,
        payment: state.form.payment,
        comment: state.form.comment.trim(),
      },
    })
    state.cart = []
    saveCart()
    state.success = data.order
    state.form.comment = ''
    state.submitting = false
    state.step = 1
    haptic('medium')
    go('success')
  } catch (error) {
    state.submitting = false
    render()
    toast(error.message)
    if (error.status === 401 && state.settings.botUrl) {
      window.open(state.settings.botUrl, '_blank')
    }
  }
}

function handleAction(action, dataset, node) {
  switch (action) {
    case 'close-sheet':
      closeSheet()
      break
    case 'story-toggle': {
      const video = node?.querySelector('video')
      if (!video) return
      if (video.paused) {
        video.play().then(() => node.classList.add('is-playing')).catch(() => toast('Videoni ijro etib bo‘lmadi'))
      } else {
        video.pause()
        node.classList.remove('is-playing')
      }
      break
    }
    case 'sheet-qty': {
      const next = state.qty + Number(dataset.dir)
      state.qty = Math.min(Math.max(next, 1), 10)
      renderSheet()
      break
    }
    case 'add-to-cart': {
      const product = findProduct(state.productId)
      if (!product) return
      // O‘lcham tanlanmasa checkout’da server rad etadi — shu yerda to‘xtatamiz.
      if (product.sizes.length && !state.size) {
        toast('Avval o‘lchamni tanlang')
        return
      }
      if (addToCart(product, state.size, state.qty)) {
        closeSheet()
        toast('Savatchaga qo‘shildi ✓')
      }
      break
    }
    case 'qty': {
      const item = state.cart.find((entry) => cartKey(entry.productId, entry.size) === dataset.key)
      if (!item) return
      item.qty += Number(dataset.dir)
      if (item.qty < 1) state.cart = state.cart.filter((entry) => entry !== item)
      if (item.qty > 10) item.qty = 10
      saveCart()
      renderCart()
      break
    }
    case 'remove':
      state.cart = state.cart.filter((entry) => cartKey(entry.productId, entry.size) !== dataset.key)
      saveCart()
      renderCart()
      break
    case 'checkout':
      state.errors = {}
      state.step = 1
      go('checkout')
      break
    case 'select-delivery':
      state.form.delivery = dataset.value
      delete state.errors.address
      renderCheckout()
      break
    case 'select-payment':
      state.form.payment = dataset.value
      delete state.errors.payment
      renderCheckout()
      break
    case 'step-next':
      if (state.step < 4) {
        if (!validateStep(state.step)) {
          renderCheckout()
          return
        }
        state.step += 1
        renderCheckout()
      } else {
        submitOrder()
      }
      break
    case 'step-back':
      if (state.step > 1) {
        state.step -= 1
        renderCheckout()
      }
      break
    case 'share-contact':
      if (!tg?.requestContact) {
        toast('Kontakt ulashish faqat Telegram ilovasida ishlaydi')
        return
      }
      tg.requestContact((sent) => {
        if (sent) {
          toast('Raqam yuborildi, yangilanmoqda…')
          setTimeout(async () => {
            await refreshMe()
            toast('Raqam to‘ldirildi ✓')
          }, 1500)
        }
      })
      break
    case 'share-location':
      if (!tg?.requestLocation) {
        toast('Lokatsiya faqat Telegram ilovasida ishlaydi')
        return
      }
      tg.requestLocation((sent) => {
        if (sent) {
          toast('Lokatsiya yuborildi…')
          setTimeout(async () => {
            const user = await refreshMe()
            if (user?.lat) toast('Lokatsiya qabul qilindi ✓')
          }, 1500)
        }
      })
      break
    case 'refresh-orders':
      loadOrders()
      break
    case 'open-bot':
      window.open(dataset.url, '_blank')
      break
    default:
      break
  }
}

/* -------------------------------- events --------------------------------- */

document.addEventListener('click', (event) => {
  if (event.target.closest('[data-scroll-catalog]')) { document.querySelector('.arrivals-head')?.scrollIntoView({ behavior: 'smooth' }); return }
  const nav = event.target.closest('[data-nav]')
  if (nav) {
    event.preventDefault()
    go(nav.dataset.nav)
    return
  }
  const category = event.target.closest('[data-category]')
  if (category) {
    state.category = category.dataset.category
    renderCatalog()
    return
  }
  const sizeButton = event.target.closest('[data-size]')
  if (sizeButton) {
    state.size = sizeButton.dataset.size
    renderSheet()
    haptic()
    return
  }
  const actionNode = event.target.closest('[data-action]')
  if (actionNode) {
    event.preventDefault()
    handleAction(actionNode.dataset.action, actionNode.dataset, actionNode)
    return
  }
  const card = event.target.closest('[data-product]')
  if (card) {
    openProduct(Number(card.dataset.product))
    return
  }
  if (event.target.closest('[data-close="sheet"]')) closeSheet()
})

document.addEventListener('input', (event) => {
  if (event.target.id === 'searchInput') { state.search = event.target.value.trim(); renderCatalog(); const input = el('searchInput'); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); return }
  const field = event.target.closest('[data-field]')
  if (!field) return
  state.form[field.dataset.field] = field.value
  if (state.errors[field.dataset.field]) {
    delete state.errors[field.dataset.field]
    field.closest('.field')?.classList.remove('is-error')
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSheet()
})

if (tg?.BackButton) {
  tg.BackButton.onClick(() => {
    if (state.view === 'checkout' && state.step > 1) {
      state.step -= 1
      render()
    } else if (state.view !== 'catalog') {
      go('catalog')
    }
  })
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.view === 'checkout') refreshMe()
})

/* --------------------------------- init ---------------------------------- */

async function init() {
  const params = new URLSearchParams(location.search)
  const initialView = params.get('view')
  try {
    const data = await api('/api/bootstrap')
    state.categories = data.categories ?? []
    state.products = data.products ?? []
    state.settings = { ...state.settings, ...(data.settings ?? {}) }
    state.user = data.user
    if (state.user) {
      state.form.name = state.user.name || ''
      state.form.phone = state.user.phone || ''
      state.form.lat = state.user.lat ?? null
      state.form.lon = state.user.lon ?? null
    }
  } catch {
    state.ordersError = 'Server bilan aloqa yo‘q. Keyinroq qayta urinib ko‘ring.'
  }

  el('loader').style.opacity = '0'
  setTimeout(() => el('loader').classList.add('hidden'), 220)
  updateBadges()

  if (initialView === 'cart') state.view = 'cart'
  else if (initialView === 'orders') state.view = 'orders'
  else state.view = 'catalog'

  render()
  if (state.view === 'orders') loadOrders()
  syncBackButton()
}

init()
