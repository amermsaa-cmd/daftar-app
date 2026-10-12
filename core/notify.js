// @ts-check
// رسائل الواتساب للعميل: نص الرسالة وقرار الإرسال. يستعملها التطبيق (اليدوي) والجسر (التلقائي).
import { formatMoney, toLatinDigits } from './util.js';

// عبارة العملية في الرسالة
const KIND_LINE = { purchase: ['مشترياتك بالآجل', '🛒'], payment: ['تسديدك', '✅'], return: ['مرتجعك', '↩️'] };
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
  return `${parts.day}/${parts.month}/${parts.year}${NB}م${NB.repeat(3)}-${NB.repeat(3)}${h}:${parts.minute}${NB}${pm ? 'م' : 'ص'}`;
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
 * بيانات البقالة: الاسم (يظهر أول سطر في رسالة الواتساب) والهاتف (في الكشف المطبوع فقط).
 * الاسم القديم wa.shop يبقى احتياطاً.
 * @param {Record<string, any>} settings
 */
export function shopInfo(settings) {
  const s = settings || {};
  const str = (/** @type {any} */ v) => (typeof v === 'string' ? v : '');
  return { name: str(s['shop.name']) || str(s['wa.shop']), phone: str(s['shop.phone']) };
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
    shop: shopInfo(s).name,
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
  const head = w.shop ? [`🏪 *${w.shop}*`, ''] : [];
  /** @type {string[]} */
  const body = [];
  const kind = /** @type {Record<string,string[]>} */ (KIND_LINE)[lastTxn ? lastTxn.kind : ''];
  if (w.last && lastTxn && kind) body.push(`${kind[1]} ${kind[0]}`, `💰 *${formatMoney(lastTxn.amount)}* ريال`, '');
  if (w.bal) {
    body.push(c.balance > 0 ? `📊 رصيدك الحالي : *${formatMoney(c.balance)}* ريال`
      : c.balance < 0 ? `📊 لك عندنا : *${formatMoney(-c.balance)}* ريال`
        : '📊 حسابك مسدّد، لا يوجد مبلغ مستحق');
  }
  body.push(`🕐 ${waStamp(lastTxn ? lastTxn.ts : nowTs)}`);
  return [...head, ...body].join('\n');
}

/**
 * رسالة «تذكير بالرصيد» الودية (من الزر اليدوي، ولاحقاً التذكير الشهري).
 * @param {import('./ops.js').State} state
 * @param {string} cid
 * @param {number} [nowTs]
 * @returns {{ text: string, state: 'debt' | 'zero' | 'credit', amount: number, shop: string, lines: string[], stamp: string } | null}
 */
export function waReminder(state, cid, nowTs = Date.now()) {
  const c = state.customers.get(cid);
  if (!c) return null;
  const shop = waSettings(state.settings).shop;
  const st = c.balance > 0 ? 'debt' : c.balance < 0 ? 'credit' : 'zero';
  const amount = Math.abs(c.balance);
  /** @type {string[]} */
  const lines = st === 'debt' ? [`رصيدكم للمشتريات الأجلة هو : ${formatMoney(amount)} ريال`, 'نأمل منكم سرعة السداد']
    : st === 'credit' ? [`لكم عندنا : ${formatMoney(amount)} ريال`]
      : ['حسابكم مسدّد، لا يوجد مبلغ مستحق'];
  lines.push('شاكرين لكم تعاملكم معنا 🌷');
  const stamp = waStamp(nowTs);
  const icon = st === 'debt' ? '💰 ' : st === 'credit' ? '💰 ' : '✅ ';
  const text = [...(shop ? [`🏪 *${shop}*`, ''] : []), icon + lines[0].replace(/: ([\d.,٠-٩]+) ريال/, ': *$1* ريال'), ...lines.slice(1), '', `🕐 ${stamp}`].join('\n');
  return { text, state: st, amount, shop, lines, stamp };
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

// ===== التذكير الشهري التلقائي (الجسر يرسله، والتطبيق يضبطه ويعرض معاينته) =====

/**
 * إعدادات التذكير الشهري من إعدادات الدفتر. مطفأ افتراضياً.
 * @param {Record<string, any>} settings
 */
export function remSettings(settings) {
  const s = settings || {};
  const int = (/** @type {any} */ v, /** @type {number} */ d, /** @type {number} */ lo, /** @type {number} */ hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
  return {
    on: s['rem.on'] === true,
    day: int(s['rem.day'], 25, 1, 28),
    hour: int(s['rem.hour'], 10, 0, 23),
    min: int(s['rem.min'], 5000, 0, 100000000), // أقل رصيد بالهللة (50 ريال)
    now: Number.isInteger(s['rem.now']) ? /** @type {number} */ (s['rem.now']) : 0, // «أرسل الآن»: وقت الضغط
  };
}

/** @param {number} ts تاريخ بتوقيت الرياض: {y, m, d, h} */
export function riyadhParts(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24 };
}

/**
 * هل حان وقت دفعة تذكير؟ يرجع مفتاح الدفعة (يمنع التكرار) أو null.
 * شهرياً: في يوم الشهر المحدد بعد الساعة المحددة (طوال اليوم). يدوياً: خلال 6 ساعات من «أرسل الآن».
 * @param {Record<string, any>} settings @param {number} nowTs
 */
export function remDue(settings, nowTs) {
  const c = remSettings(settings);
  if (c.now && nowTs - c.now >= 0 && nowTs - c.now < 6 * 3600 * 1000) return `now${c.now.toString(36)}`;
  if (!c.on) return null;
  const t = riyadhParts(nowTs);
  if (t.d === c.day && t.h >= c.hour) return `${t.y}${String(t.m).padStart(2, '0')}`;
  return null;
}

/** معرّف إشعار التذكير لعميل في دفعة (لا يتكرر لنفس العميل في نفس الدفعة). */
export const remOpId = (/** @type {string} */ key, /** @type {string} */ cid) => `rem-${key}-${cid}`;

/**
 * من سيصله التذكير: عليه رصيد لا يقل عن الحد، وله جوال، غير مؤرشف، ولم يُطفأ له الإشعار.
 * @param {import('./ops.js').State} state @param {Record<string, any>} [settings]
 * @returns {{ cid: string, name: string, phone: string, balance: number }[]}
 */
export function remPlan(state, settings = state.settings) {
  const c = remSettings(settings);
  const out = [];
  for (const x of state.customers.values()) {
    if (x.archived || x.waOff || !waNumber(x.phone)) continue;
    if (x.balance <= 0 || x.balance < c.min) continue;
    out.push({ cid: x.id, name: x.name, phone: /** @type {string} */ (x.phone), balance: x.balance });
  }
  return out.sort((a, b) => b.balance - a.balance);
}
