// @ts-check
// الدفتر: الواجهة اللي تستخدمها التطبيقات (الجوال، الكمبيوتر، السيرفر).
// يسجّل عمليات جديدة بعد التحقق منها، ويدمج عمليات جاية من جهاز ثاني،
// ويعطي الحالة المحسوبة. التخزين نفسه (IndexedDB في الجوال، SQLite في الكمبيوتر)
// مسؤولية التطبيق: يحفظ ما يرجعه record/merge ويحمّله عند التشغيل.

import { OP, KINDS, reduce, isValidOp, nextCode } from './ops.js';
import { shortId, opId, normalizeName, compactName, phoneKey, toLatinDigits } from './util.js';

/** @typedef {import('./ops.js').Op} Op */
/** @typedef {import('./ops.js').State} State */
/** @typedef {import('./ops.js').Customer} Customer */
/** @typedef {import('./ops.js').Txn} Txn */
/** @typedef {import('./ops.js').TxnKind} TxnKind */

export class LedgerError extends Error {
  /** @param {string} code @param {Record<string, any>} [details] */
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

/** بادئة باركود بطاقة العميل في النظام الجديد. */
export const CARD_PREFIX = 'D-';

export class Ledger {
  /**
   * @param {object} opts
   * @param {string} opts.deviceId  معرّف ثابت لهذا الجهاز
   * @param {Iterable<Op>} [opts.ops] العمليات المحفوظة سابقاً
   * @param {() => number} [opts.clock] للاختبارات
   */
  constructor({ deviceId, ops = [], clock = () => Date.now() }) {
    if (!deviceId) throw new Error('deviceId required');
    this.deviceId = deviceId;
    this.clock = clock;
    /** @type {Map<string, Op>} */
    this.ops = new Map();
    for (const op of ops) if (isValidOp(op)) this.ops.set(op.id, op);
    /** @type {State | null} */
    this._state = null;
  }

  /** الحالة المحسوبة (تُحسب عند الحاجة وتُخزَّن لين يتغيّر السجل). @returns {State} */
  get state() {
    if (!this._state) this._state = reduce(this.ops.values());
    return this._state;
  }

  /** كل العمليات (للحفظ أو التزامن). @returns {Op[]} */
  allOps() {
    return [...this.ops.values()];
  }

  /** معرّفات العمليات الموجودة (لمعرفة الناقص عند الطرف الثاني). */
  opIds() {
    return new Set(this.ops.keys());
  }

  /** العمليات اللي ما عند الطرف الثاني. @param {Set<string>} theirIds */
  opsMissingFrom(theirIds) {
    return this.allOps().filter((op) => !theirIds.has(op.id));
  }

  /**
   * دمج عمليات من جهاز أو ملف آخر. المكرر يُتجاهل، والتالف يُرفض.
   * @param {Iterable<any>} incoming
   * @returns {{added: Op[], rejected: number}}
   */
  merge(incoming) {
    /** @type {Op[]} */
    const added = [];
    let rejected = 0;
    for (const op of incoming) {
      if (!isValidOp(op)) { rejected++; continue; }
      if (this.ops.has(op.id)) continue;
      this.ops.set(op.id, op);
      added.push(op);
    }
    if (added.length) this._state = null;
    return { added, rejected };
  }

  /**
   * تسجيل عملية جديدة من هذا الجهاز (بدون تحقق — الدوال تحت تتحقق قبل ما تناديها).
   * @param {string} type @param {Record<string, any>} data
   * @returns {Op}
   */
  record(type, data) {
    /** @type {Op} */
    const op = { id: opId(), dev: this.deviceId, ts: this.clock(), type, data };
    this.ops.set(op.id, op);
    this._state = null;
    return op;
  }

  // ===== العملاء =====

  /** @param {string} cid */
  customer(cid) {
    const c = this.state.customers.get(cid);
    if (!c) throw new LedgerError('unknown-customer', { cid });
    return c;
  }

  /**
   * إضافة عميل. يرفض الاسم أو الجوال المكرر (إلا لو force=true بعد تأكيد الموظف).
   * @param {{name: string, phone?: string | null, cap?: number | null, opening?: number | null, legacyCode?: string | null, codeNo?: number | null, by?: string | null, force?: boolean}} input
   * @returns {{customer: Customer, ops: Op[]}}
   */
  addCustomer(input) {
    const name = (input.name || '').trim();
    if (!name) throw new LedgerError('name-required');
    if (!input.force) {
      const dupName = this.findDuplicateName(name);
      if (dupName) throw new LedgerError('duplicate-name', { customer: dupName });
      if (input.phone && input.phone.trim()) {
        const dupPhone = this.findDuplicatePhone(input.phone);
        if (dupPhone) throw new LedgerError('duplicate-phone', { customer: dupPhone });
      }
    }
    const cid = shortId();
    const ops = [this.record(OP.CUSTOMER_CREATE, {
      cid,
      name,
      phone: input.phone && input.phone.trim() ? input.phone.trim() : null,
      cap: Number.isInteger(input.cap) && /** @type {number} */ (input.cap) > 0 ? input.cap : null,
      codeNo: input.codeNo || nextCode(this.state),
      legacyCode: input.legacyCode || null,
    })];
    if (Number.isInteger(input.opening) && /** @type {number} */ (input.opening) > 0) {
      ops.push(this.record(OP.TXN, {
        tid: shortId(12), cid, kind: 'opening', amount: input.opening, note: null, by: input.by || null,
      }));
    }
    return { customer: this.customer(cid), ops };
  }

  /**
   * تعديل بيانات عميل (الاسم/الجوال/السقف).
   * @param {string} cid
   * @param {{name?: string, phone?: string | null, cap?: number | null, waOff?: boolean, force?: boolean}} patch
   */
  updateCustomer(cid, patch) {
    const c = this.customer(cid);
    /** @type {Record<string, any>} */
    const data = { cid };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new LedgerError('name-required');
      if (!patch.force && normalizeName(name) !== normalizeName(c.name)) {
        const dup = this.findDuplicateName(name, cid);
        if (dup) throw new LedgerError('duplicate-name', { customer: dup });
      }
      data.name = name;
    }
    if (patch.phone !== undefined) {
      const phone = patch.phone && patch.phone.trim() ? patch.phone.trim() : null;
      if (phone && !patch.force && phoneKey(phone) !== phoneKey(c.phone)) {
        const dup = this.findDuplicatePhone(phone, cid);
        if (dup) throw new LedgerError('duplicate-phone', { customer: dup });
      }
      data.phone = phone;
    }
    if (patch.waOff !== undefined) data.waOff = !!patch.waOff;
    if (patch.cap !== undefined) data.cap = Number.isInteger(patch.cap) && /** @type {number} */ (patch.cap) > 0 ? patch.cap : null;
    return this.record(OP.CUSTOMER_UPDATE, data);
  }

  /** أرشفة عميل (سافر/ترك المحل): يختفي من القائمة وتبقى بياناته. @param {string} cid @param {boolean} archived */
  setArchived(cid, archived) {
    this.customer(cid);
    return this.record(OP.CUSTOMER_ARCHIVE, { cid, archived: !!archived });
  }

  /**
   * إيقاف الآجل لعميل أو إلغاء الإيقاف.
   * @param {string} cid
   * @param {{frozen: boolean, until?: number | null, untilPaid?: boolean, reason?: string | null}} opts
   */
  setFrozen(cid, opts) {
    this.customer(cid);
    return this.record(OP.CUSTOMER_FREEZE, {
      cid, frozen: !!opts.frozen, until: opts.until ?? null, untilPaid: !!opts.untilPaid, reason: opts.reason ?? null,
    });
  }

  // ===== الحركات =====

  /**
   * فحص قبل الشراء: هل العميل موقوف أو بيتجاوز السقف؟ (لا يسجّل شيئاً)
   * @param {string} cid @param {number} amount بالهللة
   */
  checkPurchase(cid, amount) {
    const c = this.customer(cid);
    const frozen = isFrozenNow(c, this.clock());
    const capOn = !!this.state.settings.capEnabled;
    const cap = capOn ? effectiveCap(c, this.state.settings) : 0;
    const after = c.balance + amount;
    const overCap = cap > 0 && after > cap;
    return { ok: !frozen && !overCap, frozen, overCap, cap, after, balance: c.balance };
  }

  /**
   * تسجيل حركة على عميل.
   * الشراء لعميل موقوف أو متجاوز للسقف يُرفض بـ 'needs-approval' إلا لو approve=true
   * (الكاشير أو صاحب البقالة اختار "استثناء").
   * @param {string} cid
   * @param {TxnKind} kind
   * @param {number} amount بالهللة
   * @param {{note?: string | null, by?: string | null, ref?: string | null, approve?: boolean}} [opts]
   */
  addTxn(cid, kind, amount, opts = {}) {
    const c = this.customer(cid);
    if (!KINDS.includes(kind)) throw new LedgerError('bad-kind', { kind });
    if (!Number.isInteger(amount) || amount <= 0) throw new LedgerError('bad-amount', { amount });
    if (c.archived) throw new LedgerError('archived', { customer: c });
    if (kind === 'purchase' && !opts.approve) {
      const check = this.checkPurchase(cid, amount);
      if (!check.ok) throw new LedgerError('needs-approval', { check, customer: c });
    }
    const op = this.record(OP.TXN, {
      tid: shortId(12), cid, kind, amount,
      note: opts.note || null, by: opts.by || null, ref: opts.ref || null,
      approved: kind === 'purchase' && opts.approve ? true : undefined,
    });
    return { op, txn: /** @type {Txn} */ (this.state.txns.get(op.data.tid)), balance: this.customer(cid).balance };
  }

  /** @param {string} cid @param {number} amount @param {Parameters<Ledger['addTxn']>[3]} [opts] */
  purchase(cid, amount, opts) { return this.addTxn(cid, 'purchase', amount, opts); }
  /** @param {string} cid @param {number} amount @param {Parameters<Ledger['addTxn']>[3]} [opts] */
  payment(cid, amount, opts) { return this.addTxn(cid, 'payment', amount, opts); }
  /** @param {string} cid @param {number} amount @param {Parameters<Ledger['addTxn']>[3]} [opts] */
  ret(cid, amount, opts) { return this.addTxn(cid, 'return', amount, opts); }

  /**
   * إلغاء حركة سابقة (الحركة تبقى في السجل مشطوبة). يحتاج رمز صاحب البقالة في الواجهة.
   * @param {string} tid @param {string | null} [reason]
   */
  voidTxn(tid, reason = null) {
    const t = this.state.txns.get(tid);
    if (!t) throw new LedgerError('unknown-txn', { tid });
    if (t.voided) throw new LedgerError('already-voided', { tid });
    return this.record(OP.TXN_VOID, { tid, reason });
  }

  /**
   * تعديل "الرصيد السابق من الدفتر": يلغي القديم ويسجّل الجديد (أو يلغيه لو صفر).
   * @param {string} cid @param {number} amount بالهللة (0 = بدون رصيد سابق)
   */
  setOpening(cid, amount) {
    const c = this.customer(cid);
    /** @type {Op[]} */
    const ops = [];
    for (const tid of c.txnIds) {
      const t = this.state.txns.get(tid);
      if (t && t.kind === 'opening' && !t.voided) ops.push(this.voidTxn(tid, 'تعديل الرصيد السابق'));
    }
    if (Number.isInteger(amount) && amount > 0) {
      ops.push(this.record(OP.TXN, { tid: shortId(12), cid, kind: 'opening', amount, note: null }));
    }
    return ops;
  }

  // ===== الإعدادات (المشتركة بين أجهزة المحل) =====

  /** @param {string} key @param {any} value */
  setSetting(key, value) {
    return this.record(OP.SETTING, { key, value });
  }

  // ===== البحث =====

  /**
   * العثور على عميل من مسح بطاقة أو رقم: "D-XXXXXXXX" أو "CUST-0085" (البطاقات القديمة) أو "85".
   * @param {string} raw
   * @returns {Customer | null}
   */
  findByCode(raw) {
    const s = this.state;
    const code = toLatinDigits(String(raw || '')).trim().toUpperCase();
    if (!code) return null;
    if (code.startsWith(CARD_PREFIX)) return s.customers.get(code.slice(CARD_PREFIX.length)) || null;
    if (code.startsWith('CUST-')) {
      const byLegacy = s.legacyCodes.get(code);
      if (byLegacy) return s.customers.get(byLegacy) || null;
      const n = Number(code.slice(5));
      const cid = Number.isInteger(n) ? s.codes.get(n) : undefined;
      return cid ? s.customers.get(cid) || null : null;
    }
    if (/^\d+$/.test(code)) {
      const cid = s.codes.get(Number(code));
      return cid ? s.customers.get(cid) || null : null;
    }
    return null;
  }

  /**
   * بحث بالاسم أو الرقم أو الجوال. الأقرب أولاً.
   * @param {string} query
   * @param {{includeArchived?: boolean, limit?: number}} [opts]
   * @returns {Customer[]}
   */
  search(query, { includeArchived = false, limit = 20 } = {}) {
    const q = toLatinDigits(query || '').trim();
    const list = [...this.state.customers.values()].filter((c) => includeArchived || !c.archived);
    if (!q) return list.sort((a, b) => a.codeNo - b.codeNo).slice(0, limit);
    /** @type {{c: Customer, score: number}[]} */
    const hits = [];
    if (/^\d+$/.test(q)) {
      for (const c of list) {
        if (String(c.codeNo) === q) hits.push({ c, score: 0 });
        else if (q.length >= 4 && phoneKey(c.phone).includes(q.replace(/^0+/, ''))) hits.push({ c, score: 1 });
        else if (String(c.codeNo).startsWith(q)) hits.push({ c, score: 2 });
      }
    } else {
      const nq = normalizeName(q);
      const cq = compactName(q);
      for (const c of list) {
        const nn = normalizeName(c.name);
        if (nn === nq) hits.push({ c, score: 0 });
        else if (nn.startsWith(nq)) hits.push({ c, score: 1 });
        else if (nn.split(' ').some((w) => w.startsWith(nq))) hits.push({ c, score: 2 });
        else if (nn.includes(nq) || compactName(c.name).includes(cq)) hits.push({ c, score: 3 });
      }
    }
    return hits.sort((a, b) => a.score - b.score || a.c.codeNo - b.c.codeNo).slice(0, limit).map((h) => h.c);
  }

  /** @param {string} name @param {string} [excludeCid] */
  findDuplicateName(name, excludeCid) {
    const key = compactName(name);
    if (!key) return null;
    for (const c of this.state.customers.values()) {
      if (c.id !== excludeCid && compactName(c.name) === key) return c;
    }
    return null;
  }

  /** @param {string} phone @param {string} [excludeCid] */
  findDuplicatePhone(phone, excludeCid) {
    const key = phoneKey(phone);
    if (key.length < 9) return null;
    for (const c of this.state.customers.values()) {
      if (c.id !== excludeCid && phoneKey(c.phone) === key) return c;
    }
    return null;
  }
}

// ===== دوال مساعدة (بدون حالة) =====

/**
 * السقف الفعّال للعميل بالهللة: سقفه الخاص، وإلا السقف العام (0 = بلا سقف).
 * @param {Customer} c @param {Record<string, any>} settings
 */
export function effectiveCap(c, settings) {
  if (c.cap && c.cap > 0) return c.cap;
  const g = Number(settings.globalCap || 0);
  return Number.isInteger(g) && g > 0 ? g : 0;
}

/**
 * هل العميل موقوف الآن؟ الإيقاف ينتهي لحاله بانتهاء المدة أو بالسداد الكامل (لو كان شرطه السداد).
 * @param {Customer} c @param {number} now
 */
export function isFrozenNow(c, now) {
  const f = c.freeze;
  if (!f) return false;
  if (f.until && now > f.until) return false;
  if (f.untilPaid && c.balance <= 0) return false;
  return true;
}

/** نص الباركود المطبوع على بطاقة العميل. @param {Customer} c */
export function cardCode(c) {
  return CARD_PREFIX + c.id;
}
