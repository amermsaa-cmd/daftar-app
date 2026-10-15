// @ts-check
// نقل الدفتر الورقي: تحليل قائمة ملصوقة (سطر لكل عميل) ومراجعتها وإضافتها دفعة واحدة، ومطابقة المجموع.
// الرصيد السابق يُسجَّل عملية «opening» (لا يُرسل عنها واتساب).
import { toLatinDigits, toHalalas, compactName, phoneKey, formatMoney } from './util.js';

/**
 * @typedef {object} PaperRow
 * @property {number} line      رقم السطر في النص (من 1)
 * @property {string} name
 * @property {string} phone
 * @property {string} amountText الرصيد كما كُتب (فارغ = بلا رصيد)
 * @property {number | null} amount بالهللة (null = بلا رصيد سابق)
 * @property {string | null} error  سبب الرفض: 'name-required' | 'bad-amount' | 'duplicate-name' | 'duplicate-in-list'
 * @property {string | null} warn   تنبيه لا يمنع: 'duplicate-phone'
 */

// رقم جوال سعودي: 05xxxxxxxx أو 5xxxxxxxx أو 9665xxxxxxxx أو 009665xxxxxxxx (يقبل مسافات/شرطات بين الأرقام)
const PHONE_RE = /(?:^|[\s,;،\t(])((?:00966|966|0)?[\s-]?5(?:[\s-]?\d){8})(?=$|[\s,;،\t)])/;
// رقم المبلغ في آخر السطر: 1,712.20 أو 1712.20 أو 832 (فاصلة الآلاف مسموحة)
const AMOUNT_END_RE = /(?:^|[\s,;،\t:=-])(\d{1,3}(?:,\d{3})+(?:[.٫]\d+)?|\d+(?:[.٫]\d+)?)\s*(?:ريال|ر\.?س|SAR)?\s*$/i;

/**
 * يحلّل نصاً ملصوقاً: كل سطر «اسم [جوال] [رصيد]»، بفاصل مسافة أو Tab أو فاصلة. الأسطر الفارغة تُهمل.
 * @param {string} text
 * @returns {PaperRow[]}
 */
export function parsePaperList(text) {
  /** @type {PaperRow[]} */
  const rows = [];
  toLatinDigits(String(text || '')).split(/\r?\n/).forEach((raw, i) => {
    let s = raw.replace(/[‎‏‪-‮]/g, '').trim();
    if (!s) return;
    let phone = '';
    const pm = s.match(PHONE_RE);
    if (pm) { phone = pm[1].replace(/[\s-]/g, ''); s = s.replace(pm[1], ' '); }
    let amountText = '';
    let bad = false;
    const am = s.match(AMOUNT_END_RE);
    if (am) { amountText = am[1]; s = s.slice(0, am.index) + ' '; }
    else if (/\d/.test(s.trim().split(/\s+/).pop() || '')) bad = true; // آخر كلمة فيها رقم لكنه ليس مبلغاً صحيحاً (مثل 12x)
    const name = s.replace(/[\t,;،:=\-]+/g, ' ').replace(/\s+/g, ' ').trim();
    const amount = amountText ? toHalalas(amountText.replace(/,(?=\d{3}\b)/g, '')) : null;
    /** @type {string | null} */
    let error = null;
    if (!name) error = 'name-required';
    else if (bad || (amountText && amount === null && !/^0+([.٫]0+)?$/.test(amountText))) error = 'bad-amount';
    rows.push({ line: i + 1, name, phone, amountText, amount, error, warn: null });
  });
  return rows;
}

/**
 * يراجع الصفوف على الدفتر: الاسم المكرر (مع الدفتر أو داخل القائمة) خطأ، والجوال المكرر تنبيه فقط (الرقم المشترك مسموح).
 * @param {{ state: import('./ops.js').State }} ledger
 * @param {PaperRow[]} rows
 * @returns {PaperRow[]}
 */
export function checkPaperRows(ledger, rows) {
  const names = new Set([...ledger.state.customers.values()].map((c) => compactName(c.name)));
  const phones = new Set([...ledger.state.customers.values()].map((c) => phoneKey(c.phone)).filter((k) => k.length >= 9));
  const out = rows.map((r) => ({ ...r }));
  const seenNames = new Set();
  const seenPhones = new Set();
  for (const r of out) {
    r.warn = null;
    const k = compactName(r.name);
    if (!r.error && k) {
      if (names.has(k)) r.error = 'duplicate-name';
      else if (seenNames.has(k)) r.error = 'duplicate-in-list';
    }
    if (!r.error) {
      seenNames.add(k);
      const pk = phoneKey(r.phone);
      if (pk.length >= 9 && (phones.has(pk) || seenPhones.has(pk))) r.warn = 'duplicate-phone';
      if (pk.length >= 9) seenPhones.add(pk);
    }
  }
  return out;
}

/**
 * يضيف الصفوف الصالحة (بلا خطأ) واحداً واحداً. فشل صف لا يوقف البقية.
 * @param {import('./ledger.js').Ledger} ledger
 * @param {PaperRow[]} rows
 * @param {{by?: string | null}} [o]
 * @returns {{added: number, total: number, failed: {line: number, name: string, code: string}[]}}
 */
export function importPaperRows(ledger, rows, { by = null } = {}) {
  let added = 0;
  let total = 0;
  /** @type {{line: number, name: string, code: string}[]} */
  const failed = [];
  for (const r of checkPaperRows(ledger, rows)) {
    if (r.error) continue;
    try {
      ledger.addCustomer({ name: r.name, phone: r.phone || null, opening: r.amount, by, force: true });
      added++; total += r.amount || 0;
    } catch (e) { failed.push({ line: r.line, name: r.name, code: String(/** @type {any} */ (e).code || 'failed') }); }
  }
  return { added, total, failed };
}

/**
 * ما أُدخل من الدفتر الورقي حتى الآن: عدد العملاء الذين لهم رصيد سابق ومجموع الأرصدة السابقة (غير الملغاة).
 * @param {import('./ops.js').State} state
 */
export function openingSummary(state) {
  let count = 0;
  let total = 0;
  const cids = new Set();
  for (const t of state.txns.values()) {
    if (t.kind !== 'opening' || t.voided) continue;
    total += t.amount;
    cids.add(t.cid);
  }
  count = cids.size;
  return { count, total, customers: state.customers.size };
}

/**
 * مطابقة مجموع الدفتر الورقي مع ما أُدخل.
 * @param {number} entered مجموع الأرصدة المُدخلة (هللات)
 * @param {string} paperText ما كتبه المستخدم (ريال)
 * @returns {{state: 'empty' | 'bad' | 'match' | 'diff', diff: number, text: string}}
 */
export function reconcileText(entered, paperText) {
  const t = String(paperText || '').trim();
  if (!t) return { state: 'empty', diff: 0, text: '' };
  const paper = toHalalas(t.replace(/,(?=\d{3}\b)/g, ''));
  if (paper === null) return { state: 'bad', diff: 0, text: 'المبلغ غير صحيح' };
  const diff = paper - entered;
  if (diff === 0) return { state: 'match', diff: 0, text: '✓ مطابق' };
  return { state: 'diff', diff, text: diff > 0 ? `ينقص ${formatMoney(diff)} ريال عمّا في الدفتر الورقي` : `يزيد ${formatMoney(-diff)} ريال عمّا في الدفتر الورقي` };
}
