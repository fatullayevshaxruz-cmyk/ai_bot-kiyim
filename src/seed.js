import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { createProduct, db, ensureCategory, listProducts } from './db.js'

const escapeXml = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function cover({ title, subtitle, palette, variant = 0 }) {
  const [from, to, accent] = palette
  const cx = variant ? 620 : 300
  const cy = variant ? 430 : 520
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}" />
      <stop offset="1" stop-color="${to}" />
    </linearGradient>
    <pattern id="weave" width="56" height="56" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
      <line x1="0" y1="0" x2="0" y2="56" stroke="${accent}" stroke-opacity="0.09" stroke-width="2" />
    </pattern>
  </defs>
  <rect width="900" height="1200" fill="url(#bg)" />
  <rect width="900" height="1200" fill="url(#weave)" />
  <circle cx="${cx}" cy="${cy}" r="252" fill="none" stroke="${accent}" stroke-opacity="0.34" stroke-width="1.5" />
  <circle cx="${cx}" cy="${cy}" r="186" fill="none" stroke="${accent}" stroke-opacity="0.18" stroke-width="1" />
  <rect x="56" y="56" width="788" height="1088" fill="none" stroke="${accent}" stroke-opacity="0.2" />
  <text x="450" y="150" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="24" letter-spacing="9" fill="${accent}">STANDART UZBEKISTAN</text>
  <text x="450" y="965" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="46" fill="#f6f2ea">${escapeXml(title)}</text>
  <text x="450" y="1022" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="21" letter-spacing="5" fill="#cfc6b6">${escapeXml(subtitle)}</text>
  <line x1="380" y1="1058" x2="520" y2="1058" stroke="${accent}" stroke-opacity="0.5" />
  <text x="450" y="1108" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="18" letter-spacing="4" fill="${accent}" opacity="0.85">${variant ? 'LOOK 02' : 'LOOK 01'}</text>
</svg>`
}

const categories = [
  { slug: 'outerwear', title: 'Ustki kiyim' },
  { slug: 'suits', title: 'Kostyumlar' },
  { slug: 'knitwear', title: 'Sviter va hudilar' },
  { slug: 'tops', title: 'Ko‘ylak va futbolkalar' },
  { slug: 'bottoms', title: 'Shim va jinsilar' },
  { slug: 'shoes', title: 'Oyoq kiyim' },
  { slug: 'accessories', title: 'Aksessuarlar' },
]

const products = [
  {
    category: 'outerwear',
    title: 'Oversize vetrovka «Urban»',
    subtitle: 'WATER REPELLENT',
    price: 749000,
    sizes: ['M', 'L', 'XL', '2XL', '3XL'],
    badge: 'Novinka',
    description:
      'Shahar ritmi uchun yengil, suv qaytaruvchi matodan tikilgan oversize vetrovka. Ichki cho‘ntak va sozlanadigan etak qismi bilan.',
    palette: ['#181818', '#4b4b49', '#f1f1ed'],
  },
  {
    category: 'suits',
    title: 'Klassik kostyum «Atlas»',
    subtitle: 'PREMIUM WOOL',
    price: 1890000,
    oldPrice: 2190000,
    sizes: ['S', 'M', 'L', 'XL', 'XXL'],
    badge: 'Yangi',
    description:
      "Italiya jun matosidan tikilgan ikki qismli kostyum. Yarim astarli, yelka qismi yumshoq, kundalik va tadbir uchun mos. Tarkibi: 78% jun, 20% polyester, 2% elastan.",
    palette: ['#12100e', '#2b241c', '#c9a96b'],
  },
  {
    category: 'suits',
    title: "Ikki qismli kostyum «Registon»",
    subtitle: 'SLIM FIT',
    price: 2150000,
    sizes: ['S', 'M', 'L', 'XL'],
    description:
      "Slim bichimdagi zamonaviy kostyum. Ko'k-charx rang, mato yengil va namlikni o'tkazadi. To'y va uchrashuvlar uchun ideal tanlov.",
    palette: ['#0e1116', '#1d2733', '#b9c4d2'],
  },
  {
    category: 'knitwear',
    title: 'Standart Essential oversize xudi',
    subtitle: 'HEAVY COTTON 420GSM',
    price: 429000,
    sizes: ['S', 'M', 'L', 'XL', 'XXL'],
    badge: 'TOP',
    description:
      "Qalin paxta matodan tayyorlangan oversize xudi. Ikki qavatli kapyushon, ichki qismi yumshoq flis. Brend logotipi kashta bilan tikilgan.",
    palette: ['#141414', '#26241f', '#d8cfbd'],
  },
  {
    category: 'bottoms',
    title: 'Chino shim «Comfort»',
    subtitle: 'STRETCH TWILL',
    price: 389000,
    oldPrice: 459000,
    sizes: ['S', 'M', 'L', 'XL'],
    description:
      "Kundalik kiyish uchun qulay chino shim. Bel qismida yumshoq rezinka, 5 ta cho'ntak. Ofis va sayohat uchun mos.",
    palette: ['#15130f', '#302a20', '#c9a96b'],
  },
  {
    category: 'knitwear',
    title: 'Kashmir sviter «Noir»',
    subtitle: 'CASHMERE BLEND',
    price: 690000,
    sizes: ['M', 'L', 'XL'],
    description:
      "Yumshoq kashmir aralashmali sviter. Qishki kolleksiya, terini tishlamaydi. Dumaloq yoqa, klassik bichim.",
    palette: ['#0c0c0e', '#1a1a20', '#b7b2a8'],
  },
  {
    category: 'tops',
    title: 'Oq klassik ko‘ylak «Silk»',
    subtitle: 'COTTON SILK',
    price: 349000,
    sizes: ['S', 'M', 'L', 'XL', 'XXL'],
    description:
      "Yumshoq paxta-ipak matodan oq ko'ylak. Klassik yoqa, yashirin tugmalar. Kostyum va casual uslubda kiyish mumkin.",
    palette: ['#17140f', '#2f281d', '#e8dcc6'],
  },
  {
    category: 'tops',
    title: 'Zig‘ir ko‘ylak «Breeze»',
    subtitle: 'LINEN 100%',
    price: 319000,
    sizes: ['S', 'M', 'L', 'XL'],
    description:
      "Tabiiy zig'ir matodan yozgi ko'ylak. Havo o'tkazuvchan, issiqda salqin saqlaydi. Erkin bichim, qisqa yeng variantida ham mavjud.",
    palette: ['#131512', '#26302a', '#cbd3c2'],
  },
  {
    category: 'accessories',
    title: "Charm kamar «Buxoro»",
    subtitle: 'GENUINE LEATHER',
    price: 249000,
    sizes: [],
    description:
      "Tabiiy charm kamar, 35 mm kenglik. Guruch qisqich, 5 o'lcham teshigi. Klassik va casual kiyimlar bilan mos.",
    palette: ['#100d0a', '#2a1f16', '#c9a96b'],
  },
  {
    category: 'accessories',
    title: 'Ipak galstuk «Registan»',
    subtitle: 'SILK 100%',
    price: 189000,
    sizes: [],
    description:
      "Qo'lda tikilgan ipak galstuk. Klassik naqsh, kengligi 8 sm. Sovg'a qutisida yetkaziladi.",
    palette: ['#0d1013', '#1c2a30', '#b6c8c9'],
  },
  {
    category: 'shoes',
    title: 'Charm tufli «Samarqand»',
    subtitle: 'OXFORD',
    price: 890000,
    oldPrice: 1050000,
    sizes: ['40', '41', '42', '43', '44'],
    description:
      "Tabiiy charmdan tikilgan klassik okford tufli. Charm tagcharm, yumshoq ichki astar. Kostyum uchun ideal.",
    palette: ['#0c0c0c', '#211d18', '#cdb894'],
  },
  {
    category: 'shoes',
    title: 'Loafer «Toshkent»',
    subtitle: 'SUEDE',
    price: 790000,
    sizes: ['40', '41', '42', '43', '44'],
    description:
      'Yumshoq zamsh matodan tayyorlangan loafer. Yengil tagcharm, kundalik kiyish uchun qulay. Bichimi tor emas.',
    palette: ['#121010', '#2b2622', '#c2b39c'],
  },
]

const force = process.argv.includes('--force')

if (listProducts({ includeInactive: true }).length && !force) {
  console.log('[seed] Mahsulotlar allaqachon mavjud. Qayta yozish uchun: npm run seed -- --force')
  process.exit(0)
}

if (force) {
  db.exec('DELETE FROM products')
  console.log('[seed] Eski mahsulotlar o‘chirildi.')
}

fs.mkdirSync(config.uploadsDir, { recursive: true })

const categoryMap = new Map()
categories.forEach((category, index) => {
  const row = ensureCategory(category.slug, category.title, index + 1)
  categoryMap.set(category.slug, row.id)
})

let sort = 0
for (const product of products) {
  const slug = product.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  const images = [0, 1].map((variant) => {
    const file = `seed-${slug}-${variant + 1}.svg`
    fs.writeFileSync(
      path.join(config.uploadsDir, file),
      cover({ title: product.title, subtitle: product.subtitle, palette: product.palette, variant }),
      'utf8',
    )
    return `/uploads/${file}`
  })

  createProduct({
    categoryId: categoryMap.get(product.category),
    title: product.title,
    description: product.description,
    price: product.price,
    oldPrice: product.oldPrice ?? null,
    sizes: product.sizes,
    images,
    badge: product.badge ?? null,
    sort: sort++,
  })
  console.log(`[seed] ${product.title} — ${product.price} so‘m`)
}

console.log(`[seed] Tayyor: ${products.length} mahsulot, ${categories.length} kategoriya.`)
