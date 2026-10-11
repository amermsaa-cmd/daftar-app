// @ts-check
// سجل العمليات: قلب دفتر الأجل.
//
// الدفتر لا يحفظ الأرصدة، يحفظ "عمليات" (عميل جديد، شراء، تسديد، مرتجع...)،
// وكل عملية لها معرّف فريد. الحالة (العملاء وأرصدتهم) تُحسب من العمليات دائماً.
// لهذا التزامن بين الجوال والكمبيوتر و Google Drive والسيرفر بسيط: كل طرف يرسل
// العمليات اللي ما عند الثاني، ونفس مجموعة العمليات تعطي نفس الحالة في كل جهاز.
//
// قواعد ثابتة:
// - العمليات تُضاف فقط ولا تُعدَّل ولا تُحذف. الغلط يُصلَح بعملية "إلغاء" (txn.void).
// - المبالغ بالهللة (أعداد صحيحة).
// - الحساب حتمي: نفس العمليات بأي ترتيب وصول = نفس النتيجة.

/**
 * @typedef {'purchase' | 'payment' | 'return' | 'opening'} TxnKind
 *
 * @typedef {object} Op
 * @property {string} id   معرّف فريد للعملية
 * @property {string} dev  معرّف الجهاز اللي سجّلها
 * @property {number} ts   وقت التسجيل على الجهاز (ملّي ثانية)
 * @property {string} type نوع العملية (انظر OP)
 * @property {any} data
 *
 * @typedef {object} Freeze
 * @property {number | null} until      إيقاف حتى تاريخ (أو null)
 * @property {boolean} untilPaid        إيقاف حتى السداد الكامل
 * @property {string | null} reason
 *
 * @typedef {object} Customer
 * @property {string} id          معرّف ثابت (يُطبع في الباركود)
 * @property {number} codeNo      الرقم البشري للبحث (85)
 * @property {string | null} legacyCode رقم بطاقة النظام القديم (CUST-0085) إن وُجد
 * @property {string} name
 * @property {string | null} phone
 * @property {number | null} cap  سقف خاص بالهللة (null = السقف العام)
 * @property {boolean} archived
 * @property {Freeze | null} freeze
 * @property {number} createdAt
 * @property {number} balance     الرصيد المستحق بالهللة (موجب = على العميل)
 * @property {number} lastPaymentAt  وقت آخر تسديد (0 = لا يوجد)
 * @property {string[]} txnIds    حركاته بالترتيب
 *
 * @typedef {object} Txn
 * @property {string} id
 * @property {string} cid
 * @property {TxnKind} kind
 * @property {number} amount     بالهللة، موجب دائماً
 * @property {string | null} note
 * @property {number} ts
 * @property {string} dev
 * @property {string | null} by   اسم الموظف (اختياري)
 * @property {string | null} ref  مرجع خارجي (مثلاً رقم طلب توصيل)
 * @property {{ts: number, reason: string | null} | null} voided
 *
 * @typedef {object} State
 * @property {Map<string, Customer>} customers
 * @property {Map<string, Txn>} txns
 * @property {Map<number, string>} codes        codeNo → cid
 * @property {Map<string, string>} legacyCodes  CUST-0085 → cid
 * @property {Record<string, any>} settings
 * @property {{opId: string, problem: string}[]} problems  عمليات ما انطبقت (للتشخيص)
 */

export const OP = Object.freeze({
  CUSTOMER_CREATE: 'customer.create',
  CUSTOMER_UPDATE: 'customer.update',
  CUSTOMER_ARCHIVE: 'customer.archive',
  CUSTOMER_FREEZE: 'customer.freeze',
  TXN: 'txn',
  TXN_VOID: 'txn.void',
  SETTING: 'setting',
});

/** @type {readonly TxnKind[]} */
export const KINDS = Object.freeze(['purchase', 'payment', 'return', 'opening']);

/** أثر الحركة على الرصيد: الشراء والرصيد السابق يزيدان الدين، التسديد والمرتجع ينقصانه. @param {TxnKind} kind */
export const sign = (kind) => (kind === 'purchase' || kind === 'opening' ? 1 : -1);

/** ترتيب حتمي: بالوقت ثم بالمعرّف. @param {Op} a @param {Op} b */
export function compareOps(a, b) {
  return a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** @returns {State} */
export function emptyState() {
  return {
    customers: new Map(),
    txns: new Map(),
    codes: new Map(),
    legacyCodes: new Map(),
    settings: {},
    problems: [],
  };
}

/** فحص شكل العملية قبل قبولها (من جهاز آخر أو من ملف). @param {any} op @returns {op is Op} */
export function isValidOp(op) {
  return !!op && typeof op === 'object'
    && typeof op.id === 'string' && op.id.length > 0
    && typeof op.dev === 'string'
    && typeof op.ts === 'number' && Number.isFinite(op.ts)
    && typeof op.type === 'string'
    && op.data != null && typeof op.data === 'object';
}

/**
 * يبني الحالة من كل العمليات. ثلاث مراحل حتى ما يأثر اختلاف ساعات الأجهزة:
 * 1) العملاء الجدد (عشان أي حركة تلقى عميلها حتى لو ساعة جهازها متقدمة)،
 * 2) باقي العمليات بالترتيب،
 * 3) الإلغاءات أخيراً (الإلغاء نهائي ويلقى الحركة مهما كان ترتيب الوصول).
 * @param {Iterable<Op>} ops
 * @returns {State}
 */
export function reduce(ops) {
  const sorted = [...ops].sort(compareOps);
  const s = emptyState();
  for (const op of sorted) if (op.type === OP.CUSTOMER_CREATE) applyCreate(s, op);
  for (const op of sorted) {
    if (op.type === OP.CUSTOMER_CREATE || op.type === OP.TXN_VOID) continue;
    applyOther(s, op);
  }
  for (const op of sorted) if (op.type === OP.TXN_VOID) applyVoid(s, op);
  return s;
}

/** @param {State} s @param {Op} op */
function applyCreate(s, op) {
  const d = op.data;
  if (typeof d.cid !== 'string' || !d.cid || typeof d.name !== 'string' || !d.name.trim()) {
    s.problems.push({ opId: op.id, problem: 'bad-customer' });
    return;
  }
  if (s.customers.has(d.cid)) {
    s.problems.push({ opId: op.id, problem: 'duplicate-cid' });
    return;
  }
  // الرقم البشري: المطلوب لو متاح، وإلا أول رقم فاضي بعد الأكبر.
  // التصادم يصير بس لو جهازين أضافوا عملاء وهم منفصلين؛ والحل حتمي في كل الأجهزة.
  let codeNo = Number.isInteger(d.codeNo) && d.codeNo > 0 ? d.codeNo : 0;
  if (!codeNo || s.codes.has(codeNo)) codeNo = nextCode(s);
  /** @type {Customer} */
  const c = {
    id: d.cid,
    codeNo,
    legacyCode: typeof d.legacyCode === 'string' ? d.legacyCode : null,
    name: d.name.trim(),
    phone: typeof d.phone === 'string' && d.phone.trim() ? d.phone.trim() : null,
    cap: Number.isInteger(d.cap) && d.cap > 0 ? d.cap : null,
    archived: false,
    freeze: null,
    createdAt: op.ts,
    balance: 0,
    lastPaymentAt: 0,
    txnIds: [],
  };
  s.customers.set(c.id, c);
  s.codes.set(codeNo, c.id);
  if (c.legacyCode) s.legacyCodes.set(c.legacyCode, c.id);
}

/** @param {State} s */
export function nextCode(s) {
  let max = 0;
  for (const n of s.codes.keys()) if (n > max) max = n;
  return max + 1;
}

/** @param {State} s @param {Op} op */
function applyOther(s, op) {
  const d = op.data;
  switch (op.type) {
    case OP.TXN: {
      const c = s.customers.get(d.cid);
      if (!c) return void s.problems.push({ opId: op.id, problem: 'unknown-customer' });
      if (!KINDS.includes(d.kind) || !Number.isInteger(d.amount) || d.amount <= 0) {
        return void s.problems.push({ opId: op.id, problem: 'bad-txn' });
      }
      if (typeof d.tid !== 'string' || !d.tid || s.txns.has(d.tid)) {
        return void s.problems.push({ opId: op.id, problem: 'bad-tid' });
      }
      /** @type {Txn} */
      const t = {
        id: d.tid, cid: c.id, kind: d.kind, amount: d.amount,
        note: typeof d.note === 'string' && d.note.trim() ? d.note.trim() : null,
        ts: op.ts, dev: op.dev,
        by: typeof d.by === 'string' && d.by ? d.by : null,
        ref: typeof d.ref === 'string' && d.ref ? d.ref : null,
        voided: null,
      };
      s.txns.set(t.id, t);
      c.txnIds.push(t.id);
      c.balance += sign(t.kind) * t.amount;
      if (t.kind === 'payment' && t.ts > c.lastPaymentAt) c.lastPaymentAt = t.ts;
      return;
    }
    case OP.CUSTOMER_UPDATE: {
      const c = s.customers.get(d.cid);
      if (!c) return void s.problems.push({ opId: op.id, problem: 'unknown-customer' });
      if (typeof d.name === 'string' && d.name.trim()) c.name = d.name.trim();
      if ('phone' in d) c.phone = typeof d.phone === 'string' && d.phone.trim() ? d.phone.trim() : null;
      if ('cap' in d) c.cap = Number.isInteger(d.cap) && d.cap > 0 ? d.cap : null;
      return;
    }
    case OP.CUSTOMER_ARCHIVE: {
      const c = s.customers.get(d.cid);
      if (!c) return void s.problems.push({ opId: op.id, problem: 'unknown-customer' });
      c.archived = !!d.archived;
      return;
    }
    case OP.CUSTOMER_FREEZE: {
      const c = s.customers.get(d.cid);
      if (!c) return void s.problems.push({ opId: op.id, problem: 'unknown-customer' });
      c.freeze = d.frozen
        ? {
            until: typeof d.until === 'number' ? d.until : null,
            untilPaid: !!d.untilPaid,
            reason: typeof d.reason === 'string' && d.reason ? d.reason : null,
          }
        : null;
      return;
    }
    case OP.SETTING: {
      if (typeof d.key !== 'string' || !d.key) return void s.problems.push({ opId: op.id, problem: 'bad-setting' });
      s.settings[d.key] = d.value;
      return;
    }
    default:
      // نوع غير معروف (مثلاً من إصدار أحدث): يُتجاهَل بأمان ويبقى في السجل.
      s.problems.push({ opId: op.id, problem: 'unknown-type' });
  }
}

/** @param {State} s @param {Op} op */
function applyVoid(s, op) {
  const t = s.txns.get(op.data.tid);
  if (!t) return void s.problems.push({ opId: op.id, problem: 'unknown-txn' });
  if (t.voided) return; // إلغاء مكرر من جهازين: يكفي الأول
  t.voided = { ts: op.ts, reason: typeof op.data.reason === 'string' && op.data.reason ? op.data.reason : null };
  const c = s.customers.get(t.cid);
  if (!c) return;
  c.balance -= sign(t.kind) * t.amount;
  if (t.kind === 'payment' && c.lastPaymentAt === t.ts) {
    c.lastPaymentAt = 0;
    for (const id of c.txnIds) {
      const x = s.txns.get(id);
      if (x && x.kind === 'payment' && !x.voided && x.ts > c.lastPaymentAt) c.lastPaymentAt = x.ts;
    }
  }
}
