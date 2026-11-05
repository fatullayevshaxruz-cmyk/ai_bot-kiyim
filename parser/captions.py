"""Kanal postidagi matndan (caption) mahsulot ma'lumotlarini ajratish.

Bu modul sof funksiyalardan iborat — Telegram yoki bazaga bog'lanmaydi, shu sababli
kalitlarsiz ham sinaladi:

    python -m parser test-parse "Narx: 1 890 000 so'm  O'lcham: S-XL"

Yondashuv: avval telefon raqamlari va narx bo'laklari matndan olib tashlanadi
(ular o'lcham bilan chalkashmasin), keyin nom, narx, o'lcham, kategoriya aniqlanadi.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

# --------------------------------------------------------------------------- #
# O'lchamlar
# --------------------------------------------------------------------------- #

SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL", "5XL"]
SIZE_INDEX = {size: index for index, size in enumerate(SIZE_ORDER)}
SIZE_ALIASES = {"2XL": "XXL", "XXXL": "3XL", "XXXXL": "4XL", "XXXXXL": "5XL"}

NUMERIC_SIZE_MIN = 26
NUMERIC_SIZE_MAX = 64

_SIZE_WORDS = sorted(list(SIZE_INDEX) + list(SIZE_ALIASES), key=len, reverse=True)
_SIZE_TOKEN = "(?:" + "|".join(_SIZE_WORDS) + ")"
_SIZE_TOKEN_RE = re.compile(rf"(?<![\w]){_SIZE_TOKEN}(?![\w])", re.IGNORECASE)
_SIZE_CONTEXT_RE = re.compile(
    r"(?:o['’‘ʻ`]?lcham\w*|razmer\w*|razmerlar|size[s]?|размер\w*|ölçü)",
    re.IGNORECASE,
)
_TOKEN = rf"(?:{_SIZE_TOKEN}|\d{{2}})"
_SIZE_RUN_RE = re.compile(
    rf"(?<![\w]){_TOKEN}(?:\s*[,/|·]\s*{_TOKEN}|\s*[-–—]\s*{_TOKEN})+",
    re.IGNORECASE,
)

# --------------------------------------------------------------------------- #
# Narx
# --------------------------------------------------------------------------- #

# Valyuta yozilishi kanaldan kanalga farq qiladi: "so'm", "söm", "soʻm", "som", "сум".
# Buxoro kanallarida ko'p uchraydigan "söm" ham shu ro'yxatda bo'lishi shart.
_CURRENCY_WORDS = r"(?:s[oö]['’‘ʻ`]?m|soʻm|sum|сум|сўм|uzs|₽|р\.?|rub|руб\.?)"
_AMOUNT_NUM = r"\d[\d\s\u00a0.,]*\d|\d"

_AMOUNT_PATTERNS = (
    re.compile(rf"(?P<num>{_AMOUNT_NUM})\s*(?P<cur>{_CURRENCY_WORDS})(?![\w])", re.IGNORECASE),
    re.compile(rf"(?P<cur>\$)\s*(?P<num>{_AMOUNT_NUM})", re.IGNORECASE),
    re.compile(rf"(?P<num>{_AMOUNT_NUM})\s*(?P<cur>\$)", re.IGNORECASE),
    re.compile(rf"(?P<num>{_AMOUNT_NUM})\s*(?P<mln>mln|million|млн)\b", re.IGNORECASE),
    re.compile(
        rf"(?:narx(?:i|lar)?|price|цена|стоимость)\s*(?:[:\-–—=]|\s)\s*(?P<num>{_AMOUNT_NUM})",
        re.IGNORECASE,
    ),
)

_BARE_AMOUNT_RE = re.compile(r"(?<![\d.,])\d{4,}(?:[ .]\d{3})*(?![\d.,])")
_OLD_MARKERS_RE = re.compile(
    r"(?:eski|avvalgi|avval|old|было|старая|старый|eski\s+narx|old\s+price)", re.IGNORECASE
)
_DISCOUNT_RE = re.compile(
    r"(?:chegirma|aksiya|skidka|sale|скидк|-\s?\d{1,2}\s?%|~~)", re.IGNORECASE
)
_PHONE_RE = re.compile(
    r"(?<![\d.,])\+?\d{1,3}[\s-]?\(?\d{2,3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?![\d.,])"
)
_LONG_DIGITS_RE = re.compile(r"(?<![\d.,])\+?\d{9,13}(?![\d.,])")

# --------------------------------------------------------------------------- #
# Kategoriya / nom
# --------------------------------------------------------------------------- #

CATEGORY_TITLES = {
    "kostyumlar": "Kostyumlar",
    "casual": "Casual kiyimlar",
    "koylaklar": "Ko'ylaklar",
    "aksessuarlar": "Aksessuarlar",
    "poyabzallar": "Poyabzallar",
}

CATEGORY_KEYWORDS = {
    "poyabzallar": (
        "krossovka",
        "oyoq kiyim",
        "poyabzal",
        "tufli",
        "botinka",
        "botinkalar",
        "shippak",
        "loafer",
        "poyabzal",
        "sandal",
        "кроссовки",
        "ботинки",
        "обувь",
        "туфли",
        "sneaker",
    ),
    "kostyumlar": (
        "kostyum",
        "kastyum",
        "pijak",
        "smoking",
        "смокинг",
        "костюм",
        "suit",
        "troyka",
        "ikki qismli",
    ),
    "koylaklar": (
        "ko'ylak",
        "ko‘ylak",
        "koylak",
        "rubashka",
        "shirt",
        "рубашка",
        "bluzka",
        "блюзка",
    ),
    "aksessuarlar": (
        "kamar",
        "galstuk",
        "sumka",
        "ryukzak",
        "soat",
        "aksesuar",
        "ремень",
        "часы",
        "сумка",
        "sharf",
        "papka",
    ),
    "casual": (
        "casual",
        "futbolka",
        "jinsi",
        "jeans",
        "shim",
        "shortik",
        "xudi",
        "hoodie",
        "sviter",
        "kurtka",
        "куртка",
        "джинсы",
        "bryuki",
        "футболка",
        "svitshot",
        "kardigan",
    ),
}

HASHTAG_CATEGORY = {
    "kostyum": "kostyumlar",
    "kostyumlar": "kostyumlar",
    "suit": "kostyumlar",
    "poyabzal": "poyabzallar",
    "poyabzallar": "poyabzallar",
    "obuv": "poyabzallar",
    "krossovka": "poyabzallar",
    "koylak": "koylaklar",
    "koylaklar": "koylaklar",
    "rubashka": "koylaklar",
    "aksessuar": "aksessuarlar",
    "aksessuarlar": "aksessuarlar",
    "jinsi": "casual",
    "casual": "casual",
}

_HASHTAG_RE = re.compile(r"#[^\s#]+")
_URL_RE = re.compile(r"(?:https?://|t\.me/|www\.)\S+", re.IGNORECASE)
_EMOJI_RE = re.compile(
    "[\U0001f000-\U0001faff\u2600-\u27bf\u2b00-\u2bff\ufe0f\u2049\u2122\u00a9\u00ae]"
)
_MARKETING_RE = re.compile(
    r"^(?:yangi|new|aksiya|chegirma|sale|skidka|kolleksiya|коллекция|mavsum|premium|original|"
    r"ombor|kelib\s+tushdi|sotuvda|buyurtma|katalog)\b",
    re.IGNORECASE,
)
_CONTACT_RE = re.compile(
    r"(?:telefon|manzil|yetkazib\s+berish|buyurtma|aloqa|admin|menejer|"
    r"☎|📞|📩|📲|@[a-z0-9_]{3,})",
    re.IGNORECASE,
)
_QUOTES = "«»„“”\"'`‘’"


@dataclass
class ParsedCaption:
    """Postdan ajratilgan mahsulot ma'lumotlari (narx har doim so'mda)."""

    title: Optional[str] = None
    price: Optional[int] = None
    old_price: Optional[int] = None
    currency: str = "UZS"
    sizes: List[str] = field(default_factory=list)
    category_slug: Optional[str] = None
    description: str = ""
    badge: Optional[str] = None
    hashtags: List[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "title": self.title,
            "price": self.price,
            "old_price": self.old_price,
            "currency": self.currency,
            "sizes": self.sizes,
            "category_slug": self.category_slug,
            "description": self.description,
            "badge": self.badge,
            "hashtags": self.hashtags,
        }


# --------------------------------------------------------------------------- #
# Yordamchi funksiyalar
# --------------------------------------------------------------------------- #


def clean_text(text: Optional[str]) -> str:
    """Bir xil bo'shliqlar, ortiqcha qatorlar va maxsus bo'shliqlarni tozalaydi."""
    if not text:
        return ""
    normalized = str(text).replace("\r\n", "\n").replace("\r", "\n").replace("\u00a0", " ")
    lines = []
    for raw_line in normalized.split("\n"):
        line = re.sub(r"[ \t]+", " ", raw_line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def strip_phones(text: str) -> str:
    """Telefon raqamlari o'lcham yoki narx deb o'qilmasligi uchun olib tashlanadi."""
    return _LONG_DIGITS_RE.sub(" ", _PHONE_RE.sub(" ", text))


def _amount_value(raw: str, scale: int = 1) -> Optional[int]:
    token = re.sub(r"[ \u00a0]", "", raw or "")
    token = token.strip(".,")
    if not token:
        return None
    if re.fullmatch(r"\d{1,3}(?:[.,]\d{3})+", token):
        return int(re.sub(r"[.,]", "", token)) * scale
    if re.fullmatch(r"\d+[.,]\d{1,2}", token):
        number = float(token.replace(",", "."))
        if scale > 1:
            return int(round(number * scale))
        return int(round(number))
    digits = re.sub(r"[^\d]", "", token)
    if not digits:
        return None
    return int(digits) * scale


@dataclass
class _Amount:
    value: int
    start: int
    end: int
    currency: str = "UZS"
    is_old: bool = False


def _iter_amounts(text: str, usd_rate: int) -> List[_Amount]:
    found: List[_Amount] = []
    for pattern in _AMOUNT_PATTERNS:
        for match in pattern.finditer(text):
            raw = match.group("num")
            groups = match.groupdict()
            scale = 1
            currency = "UZS"
            if groups.get("mln"):
                scale = 1_000_000
            if groups.get("cur"):
                symbol = groups["cur"]
                if "$" in symbol:
                    currency = "USD"
                elif symbol.lower().startswith(("rub", "р")):
                    currency = "RUB"
            value = _amount_value(raw, scale)
            if not value:
                continue
            if currency == "USD":
                value = int(round(value * usd_rate))
            elif currency == "RUB":
                # Rubl narxi so'mga o'tkazilmaydi — e'tiborsiz qoldiramiz.
                continue
            found.append(_Amount(value=value, start=match.start(), end=match.end(), currency=currency))

    if not found:
        # Valyuta ham, "narx" so'zi ham yo'q — uzun sonlarni (4+ xona) narx deb qabul qilamiz.
        for match in _BARE_AMOUNT_RE.finditer(text):
            value = _amount_value(match.group(0))
            if value and value >= 1000:
                found.append(_Amount(value=value, start=match.start(), end=match.end()))

    # Bir xil oraliqdagi takrorlarni olib tashlaymiz (masalan "narx: 1 890 000 so'm").
    unique: List[_Amount] = []
    for amount in sorted(found, key=lambda item: (item.start, -(item.end - item.start))):
        if any(amount.start < other.end and other.start < amount.end for other in unique):
            continue
        unique.append(amount)
    return unique


def parse_price(text: str, usd_rate: int = 12700) -> Tuple[Optional[int], Optional[int], str]:
    """(narx, eski narx, valyuta) qaytaradi. Narx har doim so'mda (int)."""
    prepared = strip_phones(clean_text(text))
    amounts = _iter_amounts(prepared, usd_rate)
    if not amounts:
        return None, None, "UZS"

    for amount in amounts:
        # Belgilar sonlar orasida qolib ketmasligi uchun faqat sonning oldidagi qisqa
        # bo'lak tekshiriladi ("Eski narx: 2 190 000 ... Yangi narx: 1 890 000").
        before = prepared[max(0, amount.start - 40) : amount.start]
        after = prepared[amount.end : amount.end + 12]
        old_label = re.search(
            r"(?:eski|old|avvalgi|avval|было|старая|старый)[^\d]{0,16}$", before, re.IGNORECASE
        )
        if old_label or re.match(r"\s*(?:dan|->|→|➡)\s*", after):
            amount.is_old = True

    fresh = [amount for amount in amounts if not amount.is_old]
    old = next((amount for amount in amounts if amount.is_old), None)

    if not fresh:
        return old.value if old else None, None, old.currency if old else "UZS"

    price = fresh[0]
    if old is None and len(fresh) >= 2 and _DISCOUNT_RE.search(prepared):
        # "Aksiya: 2 190 000 so'm 1 890 000 so'm" kabi yozuvlarda birinchisi eski narx.
        if fresh[0].value > fresh[1].value:
            old, price = fresh[0], fresh[1]

    old_value = old.value if old and old.value > price.value else None
    return price.value, old_value, price.currency


def _canonical_sizes(tokens: List[str]) -> List[str]:
    letters: List[str] = []
    numbers: List[int] = []
    for token in tokens:
        upper = token.strip().upper()
        upper = SIZE_ALIASES.get(upper, upper)
        if upper in SIZE_INDEX:
            if upper not in letters:
                letters.append(upper)
            continue
        if upper.isdigit():
            number = int(upper)
            if NUMERIC_SIZE_MIN <= number <= NUMERIC_SIZE_MAX and number % 2 == 0:
                if number not in numbers:
                    numbers.append(number)
    letters.sort(key=lambda item: SIZE_INDEX[item])
    numbers.sort()
    return letters + [str(number) for number in numbers]


def _expand_range(chunk: str) -> List[str]:
    """`S-XL` yoki `46-52` kabi oraliqlarni to'liq ro'yxatga ochadi."""
    tokens: List[str] = []
    range_re = re.compile(
        rf"(?<![\w])(?P<a>{_SIZE_TOKEN}|\d{{2}})\s*[-–—]\s*(?P<b>{_SIZE_TOKEN}|\d{{2}})(?![\w])",
        re.IGNORECASE,
    )
    for match in range_re.finditer(chunk):
        left, right = match.group("a").upper(), match.group("b").upper()
        left, right = SIZE_ALIASES.get(left, left), SIZE_ALIASES.get(right, right)
        if left in SIZE_INDEX and right in SIZE_INDEX:
            start, end = sorted((SIZE_INDEX[left], SIZE_INDEX[right]))
            tokens.extend(SIZE_ORDER[start : end + 1])
        elif left.isdigit() and right.isdigit():
            start, end = sorted((int(left), int(right)))
            step = 2 if (end - start) % 2 == 0 else 1
            tokens.extend(str(number) for number in range(start, end + 1, step))
    return tokens


def _sizes_from_chunk(chunk: str) -> List[str]:
    tokens = _expand_range(chunk)
    tokens.extend(match.group(0) for match in _SIZE_TOKEN_RE.finditer(chunk))
    for match in re.finditer(rf"(?<![\w.,])(\d{{2}})(?![\w.,])", chunk):
        tokens.append(match.group(1))
    return _canonical_sizes(tokens)


def parse_sizes(text: str) -> List[str]:
    prepared = strip_phones(clean_text(text))
    # Narxlar o'lcham deb o'qilmasin: valyutali va "narx" bilan boshlanadigan sonlarni olib tashlaymiz.
    prepared = re.sub(
        rf"\d[\d\s\u00a0.,]*\d\s*{_CURRENCY_WORDS}|\$\s*\d[\d\s.,]*|\d[\d\s.,]*\s*\$",
        " ",
        prepared,
        flags=re.IGNORECASE,
    )
    prepared = re.sub(
        rf"(?:narx(?:i|lar)?|price|цена|стоимость)\s*[:\-–—=]?\s*\d[\d\s.,]*",
        " ",
        prepared,
        flags=re.IGNORECASE,
    )

    sizes: List[str] = []
    for line in prepared.split("\n"):
        if _SIZE_CONTEXT_RE.search(line):
            sizes.extend(_sizes_from_chunk(line))
    if not sizes:
        for match in _SIZE_RUN_RE.finditer(prepared):
            sizes.extend(_sizes_from_chunk(match.group(0)))
    if not sizes:
        for group in re.findall(r"\(([^()]{2,40})\)", prepared):
            if _SIZE_CONTEXT_RE.search(group) or _SIZE_TOKEN_RE.search(group):
                sizes.extend(_sizes_from_chunk(group))
    return _canonical_sizes(sizes)


def parse_category(text: str, default: str = "casual") -> str:
    prepared = clean_text(text).lower()
    for tag in _HASHTAG_RE.findall(prepared):
        slug = tag.lstrip("#").replace("_", "").replace("-", "")
        for key, category in HASHTAG_CATEGORY.items():
            if slug == key or slug.startswith(key):
                return category

    best_slug, best_score = default, 0
    for slug, keywords in CATEGORY_KEYWORDS.items():
        score = 0
        for keyword in keywords:
            if keyword in prepared:
                score += 2 if len(keyword) > 4 else 1
        if score > best_score:
            best_slug, best_score = slug, score
    return best_slug


def _is_noise_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return True
    without_tags = _HASHTAG_RE.sub(" ", stripped)
    without_tags = _URL_RE.sub(" ", without_tags)
    without_tags = _EMOJI_RE.sub(" ", without_tags)
    without_tags = re.sub(r"[\s\-–—_•*·|/.,:;!+=~()\[\]{}\"'«»„“”]+", " ", without_tags).strip()
    if not without_tags:
        return True
    if _is_price_only(stripped) or _is_size_only(stripped):
        return True
    return bool(_CONTACT_RE.search(stripped) and len(without_tags) < 60)


def _is_price_only(line: str) -> bool:
    leftover = re.sub(
        rf"\d[\d\s\u00a0.,]*\d\s*{_CURRENCY_WORDS}|\$\s*\d[\d\s.,]*|\d[\d\s.,]*\s*\$",
        " ",
        line,
        flags=re.IGNORECASE,
    )
    leftover = re.sub(
        r"(?:narx(?:i|lar)?|price|цена|стоимость|eski|yangi|old|chegirma|aksiya|skidka|sale)",
        " ",
        leftover,
        flags=re.IGNORECASE,
    )
    leftover = _EMOJI_RE.sub(" ", leftover)
    return not re.search(r"[A-Za-zА-Яа-яЁё]", leftover)


def _is_size_only(line: str) -> bool:
    if not (_SIZE_CONTEXT_RE.search(line) or _SIZE_RUN_RE.search(line)):
        return False
    leftover = _SIZE_CONTEXT_RE.sub(" ", line)
    leftover = _SIZE_TOKEN_RE.sub(" ", leftover)
    leftover = re.sub(r"[\s:;,.()\[\]{}<>/|·\-–—+\d'’‘ʻ`]+", " ", leftover)
    leftover = _EMOJI_RE.sub(" ", leftover)
    return not re.search(r"[A-Za-zА-Яа-яЁё]{3,}", leftover)


def _title_score(line: str) -> int:
    score = 0
    lowered = line.lower()
    if any(keyword in lowered for keyword in ("kostyum", "ko'ylak", "ko‘ylak", "krossovka", "shim", "kamar", "sumka", "kurtka")):
        score += 3
    if any(quote in line for quote in "«»„“”"):
        score += 2
    words = re.findall(r"[A-Za-zА-Яа-яЁё][\w'’‘-]*", line)
    if len(words) >= 2 and sum(1 for word in words if word[:1].isupper()) >= 2:
        score += 2
    if 10 <= len(line) <= 90:
        score += 1
    if _MARKETING_RE.search(line):
        score -= 3
    if len(line) > 120:
        score -= 2
    if _EMOJI_RE.search(line) and len(_EMOJI_RE.sub("", line).strip()) < 12:
        score -= 2
    return score


def parse_title(text: str) -> Optional[str]:
    lines = [line for line in clean_text(text).split("\n") if not _is_noise_line(line)]
    if not lines:
        return None
    best_line, best_score = None, -99
    for line in lines:
        score = _title_score(line)
        if score > best_score:
            best_line, best_score = line, score
    if not best_line or best_score < 0 and len(best_line) < 6:
        return None
    title = _EMOJI_RE.sub(" ", best_line)
    title = _HASHTAG_RE.sub(" ", title)
    title = _URL_RE.sub(" ", title)
    title = re.sub(r"^[\s\-–—•*·|:;,.]+", "", title)
    title = re.sub(r"\s+", " ", title).strip()
    # Faqat juft tashqi qo'shtirnoqlar olib tashlanadi (ichki «» belgilari qoladi).
    if len(title) > 2 and title[0] in "«\"„“" and title[-1] in "»\"“”":
        title = title[1:-1].strip()
    if len(title) > 90:
        cut = title[:90].rsplit(" ", 1)[0] or title[:90]
        title = cut.strip(" ,.;:-")
    return title or None


def parse_description(text: str, title: Optional[str] = None, limit: int = 1000) -> str:
    kept: List[str] = []
    for line in clean_text(text).split("\n"):
        if _is_noise_line(line):
            continue
        if title and line.strip() == title:
            continue
        cleaned = _HASHTAG_RE.sub(" ", line)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if cleaned and cleaned != title:
            kept.append(cleaned)
    description = "\n".join(kept).strip()
    if len(description) > limit:
        description = description[:limit].rsplit(" ", 1)[0] + "…"
    return description


# "Kardigan - 199.900 söm", "Şim — 149.900 söm" kabi qatorlar: nom + narx.
_ITEM_LINE_RE = re.compile(
    rf"^\s*(?P<name>[^\n]{{2,90}}?)\s*[-–—|:•]\s*(?P<amount>{_AMOUNT_NUM})\s*(?P<cur>{_CURRENCY_WORDS})\s*$",
    re.IGNORECASE,
)
# Narx qatorining yorlig'i bo'lib qoladigan so'zlar: "Chegirma narx: 1 800 000 so'm"
# mahsulot nomi emas. Nomda shu so'zlardan tashqari hech narsa bo'lmasa — qator tashlanadi.
_ITEM_LABEL_WORDS = {
    "narx",
    "narxi",
    "narxlar",
    "price",
    "цена",
    "стоимость",
    "eski",
    "yangi",
    "chegirma",
    "aksiya",
    "skidka",
    "sale",
    "скидка",
    "скидки",
}


def _is_label_name(name: str) -> bool:
    words = re.findall(r"[a-zа-яё']+", name.lower())
    return not words or all(word in _ITEM_LABEL_WORDS for word in words)


def parse_item_lines(text: str) -> List[Tuple[str, int]]:
    """Bitta postdagi `nom — narx` qatorlarini ajratadi.

    Kanal postlarida bitta rasm/video ostida bir nechta mahsulot bo'lishi mumkin
    ("Vetrovka - 299.900 söm / Șim - 149.900 söm"). Har bir shunday qator alohida
    kartochka bo'ladi, aks holda faqat birinchi narx saqlanib qolardi.
    """
    items: List[Tuple[str, int]] = []
    seen = set()
    for line in clean_text(text).split("\n"):
        prepared = strip_phones(line)
        match = _ITEM_LINE_RE.match(prepared)
        if not match:
            continue
        name = match.group("name").strip(" -–—|:•\t")
        lowered = re.sub(r"\s+", " ", name).lower()
        if _is_label_name(name) or not re.search(r"[A-Za-zА-Яа-яЁё]", name):
            continue
        value = _amount_value(match.group("amount"))
        if not value or value < 1000:
            continue
        if lowered in seen:
            continue
        seen.add(lowered)
        items.append((name[:90], value))
    return items


def _drop_item_lines(text: str) -> str:
    """Tavsifdan `nom — narx` qatorlari olib tashlanadi (ular alohida mahsulot bo'ladi)."""
    kept = []
    for line in text.split("\n"):
        if _ITEM_LINE_RE.match(strip_phones(line)):
            continue
        kept.append(line)
    return "\n".join(kept).strip()


def parse_badge(text: str) -> Optional[str]:
    lowered = clean_text(text).lower()
    if re.search(r"-?\s?\d{1,2}\s?%|chegirma|aksiya|skidka|sale|скидк", lowered):
        return "Chegirma"
    if re.search(r"yangi|new|kelib tushdi|новинк", lowered):
        return "Yangi"
    return None


# --------------------------------------------------------------------------- #
# Asosiy kirish nuqtasi
# --------------------------------------------------------------------------- #


def parse_caption(
    text: Optional[str],
    usd_rate: int = 12700,
    default_category: str = "casual",
) -> ParsedCaption:
    """Bitta post matnini to'liq tahlil qiladi."""
    prepared = clean_text(text)
    price, old_price, currency = parse_price(prepared, usd_rate)
    items = parse_item_lines(prepared)

    title = parse_title(prepared)
    if len(items) == 1:
        # "Kardigan - 199.900 söm": nom va narx shu qatordan olinadi, aks holda
        # sarlavha butun qator bo'lib qoladi va narx ba'zi formatlarda topilmaydi.
        title = items[0][0]
        price = items[0][1]
        if old_price and old_price <= price:
            old_price = None

    return ParsedCaption(
        title=title,
        price=price,
        old_price=old_price,
        currency=currency,
        sizes=parse_sizes(prepared),
        category_slug=parse_category(prepared, default_category),
        description=parse_description(_drop_item_lines(prepared), title),
        badge=parse_badge(prepared),
        hashtags=[tag.lstrip("#") for tag in _HASHTAG_RE.findall(prepared)],
    )


def parse_items(
    text: Optional[str],
    usd_rate: int = 12700,
    default_category: str = "casual",
) -> List[ParsedCaption]:
    """Postdan barcha mahsulotlarni ajratadi (bitta post → bir nechta kartochka)."""
    prepared = clean_text(text)
    items = parse_item_lines(prepared)
    if len(items) < 2:
        return [parse_caption(prepared, usd_rate, default_category)]

    description = parse_description(_drop_item_lines(prepared), None)
    global_sizes = parse_sizes(prepared)
    badge = parse_badge(prepared)
    hashtags = [tag.lstrip("#") for tag in _HASHTAG_RE.findall(prepared)]
    return [
        ParsedCaption(
            title=name,
            price=value,
            currency="UZS",
            sizes=parse_sizes(name) or global_sizes,
            category_slug=parse_category(name, default_category),
            description=description,
            badge=badge,
            hashtags=hashtags,
        )
        for name, value in items
    ]


def human_summary(parsed: ParsedCaption) -> str:
    """CLI uchun o'qiladigan ko'rinish."""
    price = f"{parsed.price:,}".replace(",", " ") if parsed.price else "—"
    old = f" (eski: {parsed.old_price:,})".replace(",", " ") if parsed.old_price else ""
    return "\n".join(
        [
            f"Nom:        {parsed.title or '—'}",
            f"Narx:       {price} so'm{old}",
            f"O'lchamlar: {', '.join(parsed.sizes) or '—'}",
            f"Kategoriya: {parsed.category_slug}",
            f"Belgi:      {parsed.badge or '—'}",
            f"Tavsif:     {(parsed.description[:120] + '…') if len(parsed.description) > 120 else (parsed.description or '—')}",
        ]
    )
