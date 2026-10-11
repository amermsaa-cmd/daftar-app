// @ts-check
// التقارير والكشوفات: دوال تقرأ الحالة فقط (ما تسجّل شيئاً).
// مأخوذة من منطق دفتر الأجل الحالي (db.js) بعد تحويلها لتعمل على سجل العمليات.

import { sign } from './ops.js';
import { effectiveCap, isFrozenNow } from './ledger.js';

/** @typedef {import('./ops.js').State} State */
/** @typedef {import('./ops.js').Customer} Customer */
/** @typedef {import('./ops.js').Txn} Txn */

export const ARABIC_MONTHS = Object.freeze([
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
]);

const DAY = 86400000;

/**
 * قائمة العملاء (النشطين افتراضياً) مرتبة بالرقم.
 * @param {State} s @param {{includeArchived?: boolean}} [opts]
 */
export function listCustomers(s, { includeArchived = false } = {}) {
  return [...s.customers.values()]
    .filter((c) => includeArchived || !c.archived)
    .sort((a, b) => a.codeNo - b.codeNo);
}

/**
 * حركات العميل غير الملغاة بالترتيب الزمني.
 * @param {State} s @param {string} cid @param {{includeVoided?: boolean}} [opts]
 * @returns {Txn[]}
 */
export function customerTxns(s, cid, { includeVoided = false } = {}) {
  const c = s.customers.get(cid);
  if (!c) return [];
  return c.txnIds
    .map((id) => /** @type {Txn} */ (s.txns.get(id)))
    .filter((t) => t && (includeVoided || !t.voided))
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
}

/**
 * حركات "الدورة الحالية": منذ آخر مرة وصل رصيد العميل صفر بالضبط (تصفية كاملة).
 * أساس كشف الحساب المختصر، حتى ما يتضخم بأشهر قديمة انتهت وسُدّدت.
 * @param {State} s @param {string} cid
 */
export function currentCycle(s, cid) {
  const txns = customerTxns(s, cid);
  let running = 0;
  let start = 0;
  txns.forEach((t, i) => {
    running += sign(t.kind) * t.amount;
    if (running === 0) start = i + 1;
  });
  return txns.slice(start);
}

/** @param {number} ts */
function monthKey(ts) {
  const d = new Date(ts);
  return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, year: d.getFullYear(), month: d.getMonth() + 1 };
}

/**
 * ملخص الدورة الحالية: الرصيد السابق + صافي كل شهر.
 * @param {State} s @param {string} cid
 */
export function monthlySummary(s, cid) {
  const txns = currentCycle(s, cid);
  let opening = 0;
  /** @type {Map<string, {key: string, label: string, total: number}>} */
  const months = new Map();
  for (const t of txns) {
    if (t.kind === 'opening') { opening += t.amount; continue; }
    const m = monthKey(t.ts);
    const row = months.get(m.key) || { key: m.key, label: `${ARABIC_MONTHS[m.month - 1]} ${m.year}`, total: 0 };
    row.total += sign(t.kind) * t.amount;
    months.set(m.key, row);
  }
  return { opening, months: [...months.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

/**
 * كل حركات شهر معيّن (من كامل التاريخ، حتى لو الشهر قديم ومسدّد).
 * @param {State} s @param {string} cid @param {number} year @param {number} month 1..12
 */
export function monthDetail(s, cid, year, month) {
  return customerTxns(s, cid).filter((t) => {
    const m = monthKey(t.ts);
    return m.year === year && m.month === month;
  });
}

/**
 * الأشهر اللي فيها حركات للعميل (الأحدث أولاً).
 * @param {State} s @param {string} cid
 */
export function availableMonths(s, cid) {
  /** @type {Map<string, {key: string, year: number, month: number, label: string}>} */
  const seen = new Map();
  for (const t of customerTxns(s, cid)) {
    const m = monthKey(t.ts);
    if (!seen.has(m.key)) seen.set(m.key, { ...m, label: `${ARABIC_MONTHS[m.month - 1]} ${m.year}` });
  }
  return [...seen.values()].sort((a, b) => b.key.localeCompare(a.key));
}

/**
 * كشف حساب مجمّع يوماً بيوم (للعرض أو الطباعة)، مع الرصيد الجاري بعد كل حركة.
 * @param {State} s @param {string} cid @param {{cycleOnly?: boolean}} [opts]
 */
export function statement(s, cid, { cycleOnly = true } = {}) {
  const all = customerTxns(s, cid);
  const txns = cycleOnly ? currentCycle(s, cid) : all;
  let running = 0;
  if (cycleOnly) {
    const firstIdx = all.indexOf(txns[0]);
    for (let i = 0; i < firstIdx; i++) running += sign(all[i].kind) * all[i].amount;
  }
  /** @type {{day: string, date: number, rows: {txn: Txn, after: number}[]}[]} */
  const days = [];
  for (const t of txns) {
    running += sign(t.kind) * t.amount;
    const d = new Date(t.ts);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let g = days[days.length - 1];
    if (!g || g.day !== day) { g = { day, date: t.ts, rows: [] }; days.push(g); }
    g.rows.push({ txn: t, after: running });
  }
  return { days, balance: running };
}

/**
 * أيام التأخّر: منذ آخر تسديد، وإلا منذ تسجيل العميل.
 * @param {Customer} c @param {number} now
 */
export function agingDays(c, now) {
  const base = c.lastPaymentAt || c.createdAt;
  return Math.max(0, Math.floor((now - base) / DAY));
}

/** @param {number} now */
function monthStart(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/**
 * ملخص لصاحب البقالة: إجمالي الديون، والجديد والمحصّل هالشهر، والمتأخر أكثر من 30 يوم.
 * @param {State} s @param {number} now
 */
export function analyticsSummary(s, now) {
  const ms = monthStart(now);
  let totalOutstanding = 0, newDebtMonth = 0, collectedMonth = 0, overdue30 = 0, customersWithDebt = 0;
  for (const c of s.customers.values()) {
    if (c.balance > 0) {
      totalOutstanding += c.balance;
      customersWithDebt++;
      if (agingDays(c, now) > 30) overdue30 += c.balance;
    }
  }
  for (const t of s.txns.values()) {
    if (t.voided || t.ts < ms || t.ts > now) continue;
    if (t.kind === 'purchase') newDebtMonth += t.amount;
    else if (t.kind === 'payment' || t.kind === 'return') collectedMonth += t.amount;
  }
  return {
    totalOutstanding, customersWithDebt, newDebtMonth, collectedMonth, overdue30,
    overduePct: totalOutstanding > 0 ? Math.round((overdue30 / totalOutstanding) * 100) : 0,
  };
}

/**
 * توزيع الديون حسب مدة التأخّر.
 * @param {State} s @param {number} now
 */
export function analyticsAging(s, now) {
  const b = { d0_7: 0, d8_30: 0, d31_60: 0, d60p: 0 };
  for (const c of s.customers.values()) {
    if (c.balance <= 0) continue;
    const d = agingDays(c, now);
    if (d <= 7) b.d0_7 += c.balance;
    else if (d <= 30) b.d8_30 += c.balance;
    else if (d <= 60) b.d31_60 += c.balance;
    else b.d60p += c.balance;
  }
  return b;
}

/**
 * جدول الديون مع حقول تحليلية، وفلتر اختياري.
 * @param {State} s @param {number} now
 * @param {'debt' | 'over_cap' | 'overdue30' | 'frozen' | 'regular' | 'all'} [filter]
 */
export function debtTable(s, now, filter = 'debt') {
  const capOn = !!s.settings.capEnabled;
  const rows = listCustomers(s).map((c) => {
    const cap = capOn ? effectiveCap(c, s.settings) : 0;
    return { customer: c, days: agingDays(c, now), cap, overCap: cap > 0 && c.balance > cap, frozen: isFrozenNow(c, now) };
  });
  const pick = {
    all: () => true,
    debt: (/** @type {any} */ r) => r.customer.balance > 0,
    over_cap: (/** @type {any} */ r) => r.overCap,
    overdue30: (/** @type {any} */ r) => r.customer.balance > 0 && r.days > 30,
    frozen: (/** @type {any} */ r) => r.frozen,
    regular: (/** @type {any} */ r) => r.customer.balance > 0 && r.days <= 7,
  }[filter];
  return rows.filter(pick).sort((a, b) => b.customer.balance - a.customer.balance);
}
