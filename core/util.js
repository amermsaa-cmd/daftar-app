// @ts-check
// أدوات صغيرة مشتركة: المعرّفات، تطبيع النصوص العربية، والمبالغ.
// كل المبالغ داخل النظام بالهللة (عدد صحيح) لتفادي أخطاء الكسور العشرية:
// 12.50 ريال = 1250 هللة.

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // بلا 0/O و1/I لتفادي اللبس

/**
 * معرّف قصير عشوائي (افتراضياً 8 خانات ≈ 40 بت) — يكفي لعملاء محل واحد بلا تصادم عملي.
 * @param {number} [len]
 */
export function shortId(len = 8) {
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

/** معرّف عملية فريد عالمياً. */
export function opId() {
  return globalThis.crypto.randomUUID();
}

/**
 * تطبيع الاسم للمقارنة والبحث: إزالة التشكيل والتطويل، توحيد الألف والتاء المربوطة والياء،
 * وضغط المسافات — فيتطابق "أبو خالد" و"ابو خالد" و"ابوخالد".
 * @param {string | null | undefined} text
 */
export function normalizeName(text) {
  return (text || '')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** نسخة بلا مسافات (لمطابقة "ابوخالد" مع "ابو خالد"). @param {string} text */
export function compactName(text) {
  return normalizeName(text).replace(/\s/g, '');
}

/**
 * تحويل الأرقام العربية/الفارسية إلى إنجليزية.
 * @param {string} text
 */
export function toLatinDigits(text) {
  return (text || '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

/**
 * مفتاح مقارنة رقم الجوال: آخر 9 أرقام (يتجاهل 966+ و00966 و0 في البداية).
 * @param {string | null | undefined} phone
 */
export function phoneKey(phone) {
  const digits = toLatinDigits(phone || '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : digits;
}

/**
 * تحويل مبلغ مكتوب (ريال) إلى هللات. يقبل "12" و"12.5" و"١٢٫٥".
 * يرجع null لو المبلغ غير صالح أو صفر/سالب.
 * @param {string | number} input
 */
export function toHalalas(input) {
  const s = toLatinDigits(String(input ?? '')).replace(/[٫,]/g, '.').trim();
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const v = Math.round(Number(s) * 100);
  return v > 0 ? v : null;
}

/**
 * عرض الهللات كريالات: 1250 → "12.50"، 1200 → "12".
 * @param {number} halalas
 */
export function formatMoney(halalas) {
  const neg = halalas < 0;
  const abs = Math.abs(Math.round(halalas));
  const riyal = Math.floor(abs / 100);
  const frac = abs % 100;
  const body = frac === 0 ? String(riyal) : `${riyal}.${String(frac).padStart(2, '0')}`;
  return neg ? `-${body}` : body;
}
