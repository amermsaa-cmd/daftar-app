// @ts-check
// رسائل الواتساب للعميل: نص الرسالة وقرار الإرسال. يستعملها التطبيق (اليدوي) والجسر (التلقائي).
import { formatMoney, toLatinDigits } from './util.js';

// عبارة العملية في الرسالة
const KIND_LINE = { purchase: 'مشترياتك بالآجل', payment: 'تسديدك', return: 'مرتجعك' };
const NB = '\u00A0'; // مسافة لا تنقسم: تفصل التاريخ عن الوقت بوضوح

/**
 * التاريخ ثم الوقت بتوقيت الرياض (ثابت على أي جهاز): "11/10/2026م   -   03:50م"
 * @param {number} ts
 */
export function waStamp(ts) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Riyadh', day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const h = String(parts.hour).padStart(2, '0');
  const pm = /pm/i.test(parts.dayPeriod || '');
  return `${parts.day}/${parts.month}/${parts.year}م${NB.repeat(3)}-${NB.repeat(3)}${h}:${parts.minute}${pm ? 'م' : 'ص'}`;
}

/**
 * رقم الجوال بصيغة دولية لرابط wa.me (يفترض السعودية لو بدأ بصفر أو بـ 5).
 * @param {string | null | undefined} phone
 */
export function waNumber(phone) {
  let d = toLatinDigits(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '966' + d.slice(1);
  else if (d.length === 9 && d.startsWith('5')) d = '966' + d;
  return d;
}

/**
 * إعدادات الواتساب من إعدادات الدفتر (تتزامن بين الجوالات والجسر).
 * @param {Record<string, any>} settings
 */
export function waSettings(settings) {
  const s = settings || {};
  return {
    on: s['wa.on'] === true,            // أزرار الواتساب اليدوية في التطبيق
    auto: s['wa.auto'] !== false,       // التلقائي (الجسر): الأصل، ويُطفأ بـ false
    shop: typeof s['wa.shop'] === 'string' ? s['wa.shop'] : '',
    bal: s['wa.bal'] === true,          // الرصيد مطفأ افتراضياً (كما في الدفتر القديم)
    last: s['wa.last'] !== false,
  };
}

/**
 * نص الرسالة للعميل (بدون اسمه وبدون تحية): اسم البقالة، العملية، الرصيد (اختياري)، التاريخ والوقت.
 * @param {import('./ops.js').State} state
 * @param {string} cid
 * @param {import('./ops.js').Txn | null} lastTxn العملية المذكورة
 * @param {number} [nowTs] وقت الرسالة إن لم توجد عملية
 */
export function waMessage(state, cid, lastTxn, nowTs = Date.now()) {
  const c = state.customers.get(cid);
  if (!c) return '';
  const w = waSettings(state.settings);
  /** @type {string[]} */
  const lines = [];
  if (w.shop) lines.push(w.shop);
  if (w.last && lastTxn && /** @type {Record<string,string>} */ (KIND_LINE)[lastTxn.kind]) {
    lines.push(`${/** @type {Record<string,string>} */ (KIND_LINE)[lastTxn.kind]} : ${formatMoney(lastTxn.amount)} ريال`);
  }
  if (w.bal) {
    lines.push(c.balance > 0 ? `رصيدك الحالي : ${formatMoney(c.balance)} ريال`
      : c.balance < 0 ? `لك عندنا : ${formatMoney(-c.balance)} ريال`
        : 'حسابك مسدّد، لا يوجد مبلغ مستحق');
  }
  lines.push(waStamp(lastTxn ? lastTxn.ts : nowTs));
  return lines.join('\n');
}

/**
 * لماذا لا نرسل رسالة تلقائية لهذه العملية؟ (null = أرسل)
 * @param {import('./ops.js').State} state
 * @param {import('./ops.js').Txn} txn
 * @returns {string | null}
 */
export function waSkipReason(state, txn) {
  if (txn.kind === 'opening') return 'opening';
  if (txn.voided) return 'voided';
  const c = state.customers.get(txn.cid);
  if (!c) return 'no-customer';
  if (c.archived) return 'archived';
  if (c.waOff) return 'customer-off';
  if (!waNumber(c.phone)) return 'no-phone';
  if (!waSettings(state.settings).auto) return 'auto-off';
  return null;
}
