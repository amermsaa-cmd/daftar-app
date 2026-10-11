// @ts-check
// رسائل الواتساب للعميل: نص الرسالة وقرار الإرسال. يستعملها التطبيق (اليدوي) والجسر (التلقائي).
import { formatMoney, toLatinDigits } from './util.js';

const KIND_AR = { purchase: 'شراء', payment: 'تسديد', return: 'مرتجع' };

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
    bal: s['wa.bal'] !== false,
    last: s['wa.last'] !== false,
  };
}

/**
 * نص الرسالة للعميل. بدون اسم العميل (قد يكون الاسم مثل «محمد ألمنيوم»).
 * @param {import('./ops.js').State} state
 * @param {string} cid
 * @param {import('./ops.js').Txn | null} lastTxn العملية المذكورة (null = بلا سطر آخر عملية)
 */
export function waMessage(state, cid, lastTxn) {
  const c = state.customers.get(cid);
  if (!c) return '';
  const w = waSettings(state.settings);
  const lines = ['السلام عليكم'];
  if (w.bal) {
    lines.push(c.balance > 0 ? `رصيدك الحالي: ${formatMoney(c.balance)} ر.س`
      : c.balance < 0 ? `لك عندنا: ${formatMoney(-c.balance)} ر.س`
        : 'حسابك مسدّد، لا يوجد مبلغ مستحق');
  }
  if (w.last && lastTxn) lines.push(`آخر عملية: ${KIND_AR[/** @type {'purchase'} */ (lastTxn.kind)] || lastTxn.kind} ${formatMoney(lastTxn.amount)} ر.س`);
  if (w.shop) lines.push(w.shop);
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
